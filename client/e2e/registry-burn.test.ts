/**
 * DAO economics on a fork: withdrawals go through TornadoRouter so RelayerRegistry.burn
 * deducts the pool's TORN fee from the relayer's stake — with the paymaster registered as a
 * *master* (its own ENS name + stake) and as a *worker* of an existing relayer. The whole
 * withdraw → (swap) → Aave userOp stays atomic in both modes.
 *
 *   E2E_CHAIN=mainnet (default)  the real DAO stack: router 0xd90e…, registry 0x58E8…,
 *                                FeeManager with its Uniswap TWAP, a really registered relayer
 *   E2E_CHAIN=sepolia            the sandbox copy of the stack (contracts/src/dao-sandbox)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseEther,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { RelayerService } from '@tornado-4337/relayer';
import { aavePoolAbi, erc20Abi, feeManagerAbi, paymasterAdminAbi, relayerRegistryAbi, tornadoAbi, zapAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { deployPaymaster } from '../src/deploy.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { startHarness, type Harness } from './harness.js';

const log = (m: string) => console.log(`[e2e-registry] ${m}`);
const CHAIN = (process.env.E2E_CHAIN as 'mainnet' | 'sepolia') ?? 'mainnet';

function paymasterEvents(receipt: TransactionReceipt, paymaster: Address) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === paymaster.toLowerCase())
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: paymasterAdminAbi, data: l.data, topics: l.topics })];
      } catch {
        return [];
      }
    });
}

function registryEvents(receipt: TransactionReceipt, registry: Address) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === registry.toLowerCase())
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: relayerRegistryAbi, data: l.data, topics: l.topics })];
      } catch {
        return [];
      }
    });
}

/** Shield one note, withdraw it through the relayer into Aave, return the tx receipt and flow result. */
async function withdrawIntoAave(h: Harness, prover: TornadoProver, refundTo: Address) {
  const { publicClient, setup } = h;
  const chain = setup.chain;
  const depositor = await h.newFundedAccount(parseEther('10'));
  const depositorWallet = createWalletClient({ account: depositor, chain, transport: http(h.rpcUrl) });
  const note = createNote();
  const depositTx = await depositorWallet.writeContract({
    address: h.instance,
    abi: tornadoAbi,
    functionName: 'deposit',
    args: [commitmentHex(note)],
    value: h.denomination,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  const { leaves } = await syncLeaves(publicClient, h.instance, { fromBlock: h.instanceDeployBlock, log });

  const owner = privateKeyToAccount(generatePrivateKey());
  const tokenOut = setup.demoTokenOut;
  // Mainnet: swap into the demo token and supply it; Sepolia: wrap and supply (Aave's Sepolia
  // stablecoin reserves sit above their supply caps).
  const tail = setup.aaveWeth
    ? encodeFunctionData({ abi: zapAbi, functionName: 'wrapEthAndSupply', args: [refundTo] })
    : encodeFunctionData({
        abi: zapAbi,
        functionName: 'swapEthAndSupply',
        args: [tokenOut.address, tokenOut.uniswapFee, 0n, refundTo],
      });
  const result = await sponsoredWithdraw({
    publicClient,
    chain,
    bundlerUrl: h.bundlerUrl,
    relayerUrl: h.relayerUrl,
    instance: h.instance,
    note,
    leaves,
    prover,
    owner,
    refundTo,
    tailCallsGas: 450_000n,
    tailCalls: ({ amount }) => [{ to: h.zap, value: amount, data: tail }],
    log,
  });
  expect(result.receipt.success).toBe(true);
  expect(
    await publicClient.readContract({ address: h.instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] }),
  ).toBe(true);
  const receipt = await publicClient.getTransactionReceipt({ hash: result.receipt.receipt.transactionHash });
  return { result, receipt, note, owner };
}

async function aTokenBalance(h: Harness, who: Address) {
  const reserve = await h.publicClient.readContract({
    address: h.setup.aavePool,
    abi: aavePoolAbi,
    functionName: 'getReserveData',
    args: [h.setup.aaveWeth ?? h.setup.demoTokenOut.address],
  });
  return h.publicClient.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}

describe('master mode: the paymaster is a registered relayer with its own TORN stake', () => {
  let h: Harness;
  let prover: TornadoProver;

  beforeAll(async () => {
    h = await startHarness({ chainKey: CHAIN, registry: 'master', log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('relayer status reports master mode, the stake and the burn per withdrawal', async () => {
    const status = await new RelayerRpc(h.relayerUrl).status();
    expect(status.registry.mode).toBe('master');
    expect(status.rewardAccount.toLowerCase()).toBe(h.paymaster.toLowerCase());
    expect(status.refunds).toBe(true);
    expect(BigInt(status.registry.stake)).toBe(h.registry!.minStake);
    log(`status.registry = ${JSON.stringify(status.registry)}`);
  });

  it('burns the pool fee from the paymaster stake via Router -> RelayerRegistry, still refunds the user', async () => {
    const { publicClient } = h;
    const reg = h.registry!;
    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const stakeBefore = await publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [h.paymaster],
    });
    const depositBefore = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });

    const { result, receipt } = await withdrawIntoAave(h, prover, finalRecipient);

    // 1. TORN burned from the paymaster's stake, exactly the FeeManager's fee for this pool.
    const burned = registryEvents(receipt, reg.relayerRegistry).find((e) => e.eventName === 'StakeBurned');
    expect(burned, 'StakeBurned expected').toBeDefined();
    const burnedAmount = (burned!.args as { amountBurned: bigint }).amountBurned;
    const instanceFee = await publicClient.readContract({
      address: reg.feeManager,
      abi: feeManagerAbi,
      functionName: 'instanceFee',
      args: [h.instance],
    });
    log(`TORN burned: ${burnedAmount} (FeeManager.instanceFee = ${instanceFee})`);
    expect(burnedAmount).toBeGreaterThan(0n);
    expect(burnedAmount).toBe(BigInt(instanceFee));
    const stakeAfter = await publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [h.paymaster],
    });
    expect(stakeAfter).toBe(stakeBefore - burnedAmount);

    // 2. The relay went through the router and the paymaster still got its fee + refunded the excess.
    const events = paymasterEvents(receipt, h.paymaster);
    const relayed = events.find((e) => e.eventName === 'Relayed');
    expect((relayed!.args as { viaRouter: boolean }).viaRouter).toBe(true);
    const sponsored = events.find((e) => e.eventName === 'Sponsored')!.args as { fee: bigint; actualGasCost: bigint; refund: bigint };
    log(`Sponsored: fee=${sponsored.fee} actualGasCost=${sponsored.actualGasCost} refund=${sponsored.refund}`);
    expect(sponsored.fee).toBe(result.fee);
    expect(sponsored.refund).toBeGreaterThan(0n);
    expect(await publicClient.getBalance({ address: finalRecipient })).toBe(sponsored.refund);
    const depositAfter = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });
    expect(depositAfter).toBeGreaterThan(depositBefore);

    // 3. The tail still ran atomically: aTokens on the final recipient.
    const aBal = await aTokenBalance(h, finalRecipient);
    log(`aToken balance: ${aBal}`);
    expect(aBal).toBeGreaterThan(0n);
  });

  it('refuses to sign a direct pool.withdraw (bypasses the router) and refuses to start unregistered', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const direct = encodeFunctionData({
      abi: [{ type: 'function', name: 'execute', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'execute',
      args: [
        h.instance,
        0n,
        encodeFunctionData({
          abi: tornadoAbi,
          functionName: 'withdraw',
          args: [('0x' + '11'.repeat(256)) as Hex, `0x${'00'.repeat(32)}`, `0x${'01'.repeat(32)}`, owner.address, h.paymaster, 1n, 0n],
        }),
      ],
    });
    const res = await fetch(h.relayerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'pm_getPaymasterData',
        params: [
          { sender: owner.address, nonce: '0x0', callData: direct, callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', signature: '0x' },
          h.setup.entryPoint,
          `0x${h.setup.chain.id.toString(16)}`,
          {},
        ],
      }),
    });
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toMatch(/no relayWithdraw/);

    // A paymaster wired to the router but absent from the registry is refused at boot.
    const deployerWallet = createWalletClient({ account: h.deployer, chain: h.setup.chain, transport: http(h.rpcUrl) });
    const unregistered = await deployPaymaster(deployerWallet, h.publicClient, {
      entryPoint: h.setup.entryPoint,
      verifyingSigner: h.relayerSigner.address,
      gasMarginBps: 1_000n,
      postOpGasOverhead: 45_000n,
      router: h.setup.dao.tornadoRouter,
    });
    await expect(
      RelayerService.create({ ...h.relayer.config, paymaster: unregistered, rewardAccount: undefined }, { info() {}, warn() {} }),
    ).rejects.toThrow(/not registered in RelayerRegistry/);
  });
});

describe('worker mode: an existing relayer adds the paymaster as a worker', () => {
  let h: Harness;
  let prover: TornadoProver;

  beforeAll(async () => {
    h = await startHarness({ chainKey: CHAIN, registry: 'worker', log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('fee goes to the master EOA, burn hits the master stake, paymaster only pays gas, tail still runs', async () => {
    const { publicClient } = h;
    const reg = h.registry!;
    const master = reg.master;
    const status = await new RelayerRpc(h.relayerUrl).status();
    expect(status.registry.mode).toBe('worker');
    expect(status.rewardAccount.toLowerCase()).toBe(master.toLowerCase());
    expect(status.refunds).toBe(false);

    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const masterEthBefore = await publicClient.getBalance({ address: master });
    const masterStakeBefore = await publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [master],
    });
    const depositBefore = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });

    const { result, receipt } = await withdrawIntoAave(h, prover, finalRecipient);

    // The proof named the master: it received the whole fee, its stake paid the burn.
    expect(result.quote.relayer.toLowerCase()).toBe(master.toLowerCase());
    expect(await publicClient.getBalance({ address: master })).toBe(masterEthBefore + result.fee);
    const burned = registryEvents(receipt, reg.relayerRegistry).find((e) => e.eventName === 'StakeBurned');
    const burnedAmount = (burned!.args as { amountBurned: bigint }).amountBurned;
    expect(burnedAmount).toBeGreaterThan(0n);
    const masterStakeAfter = await publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [master],
    });
    expect(masterStakeAfter).toBe(masterStakeBefore - burnedAmount);
    log(`master ${master}: +${result.fee} wei fee, -${burnedAmount} TORN stake`);

    // The paymaster: fixed fee, no refund, no "fee not received" noise, deposit paid the gas.
    const events = paymasterEvents(receipt, h.paymaster);
    const sponsored = events.find((e) => e.eventName === 'Sponsored')!.args as { refundTo: Address; refund: bigint; actualGasCost: bigint };
    expect(sponsored.refund).toBe(0n);
    expect(sponsored.refundTo.toLowerCase()).toBe('0x0000000000000000000000000000000000000000');
    expect(events.some((e) => e.eventName === 'FeeNotReceived')).toBe(false);
    expect(await publicClient.getBalance({ address: finalRecipient })).toBe(0n);
    const depositAfter = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });
    // The EntryPoint also bills the postOp gas itself, which `actualGasCost` (passed into postOp) excludes.
    const gasPaid = depositBefore - depositAfter;
    expect(gasPaid).toBeGreaterThanOrEqual(sponsored.actualGasCost);
    expect(gasPaid).toBeLessThan((sponsored.actualGasCost * 11n) / 10n);
    log(`paymaster deposit -${gasPaid} (gas incl. postOp), master keeps fee - gas = ${result.fee - gasPaid}`);

    expect(await aTokenBalance(h, finalRecipient)).toBeGreaterThan(0n);
  });
});
