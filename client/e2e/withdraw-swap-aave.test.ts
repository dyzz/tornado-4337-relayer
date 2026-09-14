import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { aavePoolAbi, erc20Abi, paymasterAdminAbi, tornadoAbi, zapAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex, toNoteString } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { paymasterHash, encodePaymasterData, DUMMY_SIGNATURE } from '@tornado-4337/relayer';
import { startHarness, type Harness } from './harness.js';

const log = (m: string) => console.log(`[e2e] ${m}`);

describe('withdraw -> swap -> Aave supply, atomically over ERC-4337 with the thin relayer', () => {
  let h: Harness;
  let prover: TornadoProver;

  beforeAll(async () => {
    h = await startHarness({ chainKey: (process.env.E2E_CHAIN as 'mainnet' | 'sepolia') ?? 'mainnet', log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('runs the whole flow and lands aTokens on the final recipient', async () => {
    const { publicClient, setup } = h;
    const chain = setup.chain;

    // --- 1. A depositor shields 0.1 ETH into the fresh instance. -------------
    const depositor = await h.newFundedAccount(parseEther('10'));
    const depositorWallet = createWalletClient({ account: depositor, chain, transport: http(h.rpcUrl) });
    const note = createNote();
    log(`note: ${toNoteString(note, 'eth', '0.1', chain.id)}`);
    const depositTx = await depositorWallet.writeContract({
      address: h.instance,
      abi: tornadoAbi,
      functionName: 'deposit',
      args: [commitmentHex(note)],
      value: h.denomination,
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    expect(depositReceipt.status).toBe('success');

    // --- 2. Sync the deposit tree from chain (exercises the log scanner). ------
    const { leaves } = await syncLeaves(publicClient, h.instance, { fromBlock: h.instanceDeployBlock, log });
    expect(leaves).toHaveLength(1);

    // --- 3. The user: an ephemeral 7702 sender + a final address for the aTokens.
    const owner = privateKeyToAccount(generatePrivateKey());
    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const tokenOut = setup.demoTokenOut;
    const reserve = await publicClient.readContract({
      address: setup.aavePool,
      abi: aavePoolAbi,
      functionName: 'getReserveData',
      args: [tokenOut.address],
    });
    const aToken = reserve.aTokenAddress;

    const paymasterDepositBefore = await publicClient.readContract({
      address: h.paymaster,
      abi: paymasterAdminAbi,
      functionName: 'getDeposit',
    });

    // --- 4. Withdraw + swap + supply in one userOp. ------------------------------
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
      refundTo: finalRecipient,
      tailCallsGas: 450_000n,
      tailCalls: ({ amount }) => [
        {
          to: h.zap,
          value: amount,
          data: encodeFunctionData({
            abi: zapAbi,
            functionName: 'swapEthAndSupply',
            args: [tokenOut.address, tokenOut.uniswapFee, 0n, finalRecipient],
          }),
        },
      ],
      log,
    });

    expect(result.receipt.success).toBe(true);
    expect(result.sender).toBe(owner.address);

    // --- 5. Assertions ---------------------------------------------------------
    // Note is spent.
    expect(
      await publicClient.readContract({
        address: h.instance,
        abi: tornadoAbi,
        functionName: 'isSpent',
        args: [nullifierHashHex(note)],
      }),
    ).toBe(true);

    // aTokens minted to the final recipient; the ephemeral sender holds nothing.
    const aBalance = await publicClient.readContract({
      address: aToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [finalRecipient],
    });
    log(`a${tokenOut.symbol} balance of ${finalRecipient}: ${aBalance}`);
    expect(aBalance).toBeGreaterThan(0n);
    expect(await publicClient.getBalance({ address: owner.address })).toBe(0n);
    expect(
      await publicClient.readContract({ address: tokenOut.address, abi: erc20Abi, functionName: 'balanceOf', args: [h.zap] }),
    ).toBe(0n);

    // Paymaster: took its fee during execution, refunded the excess, re-deposited the rest.
    const txReceipt = await publicClient.getTransactionReceipt({ hash: result.receipt.receipt.transactionHash });
    const sponsored = txReceipt.logs
      .filter((l) => l.address.toLowerCase() === h.paymaster.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: paymasterAdminAbi, data: l.data, topics: l.topics });
        } catch {
          return undefined;
        }
      })
      .find((e) => e?.eventName === 'Sponsored');
    expect(sponsored).toBeDefined();
    const { fee, actualGasCost, refund } = sponsored!.args as { fee: bigint; actualGasCost: bigint; refund: bigint };
    log(`Sponsored: fee=${fee} actualGasCost=${actualGasCost} refund=${refund}`);
    expect(fee).toBe(result.fee);
    expect(refund).toBeGreaterThan(0n);
    expect(await publicClient.getBalance({ address: finalRecipient })).toBe(refund);
    expect(await publicClient.getBalance({ address: h.paymaster })).toBe(0n);

    const paymasterDepositAfter = await publicClient.readContract({
      address: h.paymaster,
      abi: paymasterAdminAbi,
      functionName: 'getDeposit',
    });
    // Net of gas the paymaster keeps margin + service fee => deposit grows.
    expect(paymasterDepositAfter).toBeGreaterThan(paymasterDepositBefore);
    expect(fee - refund).toBeGreaterThan(actualGasCost);
    log(`paymaster deposit ${paymasterDepositBefore} -> ${paymasterDepositAfter} (+${paymasterDepositAfter - paymasterDepositBefore})`);
  });

  it('relayer refuses to sign when the bound fee is below the quote for the op gas limits', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const fee = 1n; // absurdly low
    const fakeProof = ('0x' + '11'.repeat(256)) as Hex;
    const callData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'execute',
          inputs: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'execute',
      args: [
        h.instance,
        0n,
        encodeFunctionData({
          abi: tornadoAbi,
          functionName: 'withdraw',
          args: [fakeProof, `0x${'00'.repeat(32)}`, `0x${'01'.repeat(32)}`, owner.address, h.paymaster, fee, 0n],
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
          {
            sender: owner.address,
            nonce: '0x0',
            factory: '0x7702',
            factoryData: '0x',
            callData,
            callGasLimit: '0x100000',
            verificationGasLimit: '0x30000',
            preVerificationGas: '0x20000',
            maxFeePerGas: '0x3b9aca00',
            maxPriorityFeePerGas: '0x3b9aca00',
            signature: '0x',
          },
          h.setup.entryPoint,
          `0x${h.setup.chain.id.toString(16)}`,
          { refundTo: owner.address },
        ],
      }),
    });
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32002);
    expect(body.error!.message).toMatch(/below the minimum/);
  });

  it('TS paymaster hash matches the contract getHash for an arbitrary op', async () => {
    const op = {
      sender: '0x1111111111111111111111111111111111111111' as Address,
      nonce: '0x5' as Hex,
      factory: '0x7702' as const,
      factoryData: '0x' as Hex,
      callData: '0xdeadbeef' as Hex,
      callGasLimit: '0x186a0' as Hex,
      verificationGasLimit: '0x30d40' as Hex,
      preVerificationGas: '0x7530' as Hex,
      maxFeePerGas: '0x3b9aca00' as Hex,
      maxPriorityFeePerGas: '0x1' as Hex,
      paymasterVerificationGasLimit: '0xea60' as Hex,
      paymasterPostOpGasLimit: '0x15f90' as Hex,
    };
    const terms = { validUntil: 1_900_000_000, validAfter: 12, fee: 123456789n, serviceFee: 999n, refundTo: h.deployer.address };
    const local = paymasterHash({ op, chainId: BigInt(h.setup.chain.id), paymaster: h.paymaster, terms });

    const paymasterAndData = ('0x' +
      h.paymaster.slice(2) +
      (0xea60).toString(16).padStart(32, '0') +
      (0x15f90).toString(16).padStart(32, '0') +
      encodePaymasterData(terms, DUMMY_SIGNATURE).slice(2)) as Hex;
    const packed = {
      sender: op.sender,
      nonce: 5n,
      initCode: '0x7702' as Hex,
      callData: op.callData,
      accountGasLimits: ('0x' + (0x30d40).toString(16).padStart(32, '0') + (0x186a0).toString(16).padStart(32, '0')) as Hex,
      preVerificationGas: 0x7530n,
      gasFees: ('0x' + (1).toString(16).padStart(32, '0') + (0x3b9aca00).toString(16).padStart(32, '0')) as Hex,
      paymasterAndData,
      signature: '0x' as Hex,
    };
    const onchain = await h.publicClient.readContract({
      address: h.paymaster,
      abi: [
        {
          type: 'function',
          name: 'getHash',
          stateMutability: 'view',
          inputs: [
            {
              name: 'userOp',
              type: 'tuple',
              components: [
                { name: 'sender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'initCode', type: 'bytes' },
                { name: 'callData', type: 'bytes' },
                { name: 'accountGasLimits', type: 'bytes32' },
                { name: 'preVerificationGas', type: 'uint256' },
                { name: 'gasFees', type: 'bytes32' },
                { name: 'paymasterAndData', type: 'bytes' },
                { name: 'signature', type: 'bytes' },
              ],
            },
            { name: 'validUntil', type: 'uint48' },
            { name: 'validAfter', type: 'uint48' },
            { name: 'fee', type: 'uint256' },
            { name: 'serviceFee', type: 'uint256' },
            { name: 'refundTo', type: 'address' },
          ],
          outputs: [{ type: 'bytes32' }],
        },
      ] as const,
      functionName: 'getHash',
      args: [packed, terms.validUntil, terms.validAfter, terms.fee, terms.serviceFee, terms.refundTo],
    });
    expect(onchain).toBe(local);
  });
});
