/**
 * ERC-20 pool: withdraw 100 DAI from a Tornado DAI instance and supply it to Aave
 * for the final recipient, in one userOp. The relayer is paid in DAI (priced with
 * the 1inch oracle on the mainnet fork), the paymaster refunds the excess in DAI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, decodeEventLog, encodeFunctionData, http, parseEther, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { aavePoolAbi, erc20Abi, paymasterAdminAbi, tornadoAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { startHarness, type Harness } from './harness.js';

const log = (m: string) => console.log(`[e2e-erc20] ${m}`);

describe('ERC-20 pool: withdraw DAI -> Aave supply, relayer paid in DAI', () => {
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

  it('relayer status prices the token and quotes the fee in DAI', async () => {
    const status = await new RelayerRpc(h.relayerUrl).status();
    const dai = h.setup.demoErc20;
    expect(status.ethPrices[dai.symbol.toLowerCase()]).toBeDefined();
    const weiPerDai = BigInt(status.ethPrices[dai.symbol.toLowerCase()]!);
    log(`1 ${dai.symbol} = ${weiPerDai} wei`);
    expect(weiPerDai).toBeGreaterThan(0n);

    const quote = await new RelayerRpc(h.relayerUrl).quote({ instance: h.erc20Instance, tailCallsGas: 250_000n });
    expect(quote.feeToken.toLowerCase()).toBe(dai.address.toLowerCase());
    expect(quote.tokenPerEth).toBeGreaterThan(0n);
    expect(quote.fee).toBeLessThan(h.erc20Denomination);
    log(`quote: ${quote.fee} ${quote.symbol}-units (rate ${quote.tokenPerEth}/ETH, service ${quote.serviceFee})`);
  });

  it('withdraws DAI, supplies it to Aave, refunds the fee excess in DAI', async () => {
    const { publicClient, setup } = h;
    const chain = setup.chain;
    const dai = setup.demoErc20;

    // --- shield 100 DAI ------------------------------------------------------------
    const depositor = await h.newFundedAccount(parseEther('1'));
    await h.dealErc20(depositor.address, h.erc20Denomination);
    const depositorWallet = createWalletClient({ account: depositor, chain, transport: http(h.rpcUrl) });
    const note = createNote();
    const approveTx = await depositorWallet.writeContract({
      address: dai.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [h.erc20Instance, h.erc20Denomination],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    const depositTx = await depositorWallet.writeContract({
      address: h.erc20Instance,
      abi: tornadoAbi,
      functionName: 'deposit',
      args: [commitmentHex(note)],
    });
    expect((await publicClient.waitForTransactionReceipt({ hash: depositTx })).status).toBe('success');

    const { leaves } = await syncLeaves(publicClient, h.erc20Instance, { fromBlock: h.instanceDeployBlock, log });
    expect(leaves).toHaveLength(1);

    // --- unshield -> approve -> Aave supply (no zap needed: the amount is known) ----
    const owner = privateKeyToAccount(generatePrivateKey());
    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const reserve = await publicClient.readContract({
      address: setup.aavePool,
      abi: aavePoolAbi,
      functionName: 'getReserveData',
      args: [dai.address],
    });
    const depositBefore = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });

    const result = await sponsoredWithdraw({
      publicClient,
      chain,
      bundlerUrl: h.bundlerUrl,
      relayerUrl: h.relayerUrl,
      instance: h.erc20Instance,
      note,
      leaves,
      prover,
      owner,
      refundTo: finalRecipient,
      tailCallsGas: 300_000n,
      tailCalls: ({ amount, asset }) => [
        { to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [setup.aavePool, amount] }) },
        {
          to: setup.aavePool,
          data: encodeFunctionData({ abi: aavePoolAbi, functionName: 'supply', args: [asset, amount, finalRecipient, 0] }),
        },
      ],
      log,
    });
    expect(result.receipt.success).toBe(true);
    expect(result.quote.feeToken.toLowerCase()).toBe(dai.address.toLowerCase());
    expect(result.quote.feeToken).not.toBe(zeroAddress);

    // --- assertions --------------------------------------------------------------
    expect(
      await publicClient.readContract({ address: h.erc20Instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] }),
    ).toBe(true);

    const aDai = await publicClient.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [finalRecipient] });
    log(`aDAI balance of ${finalRecipient}: ${aDai} (withdrawn ${result.amountToSender})`);
    expect(aDai).toBeGreaterThanOrEqual(result.amountToSender - 1n); // aToken rounding
    expect(await publicClient.readContract({ address: dai.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] })).toBe(0n);

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
    const { feeToken, fee, actualGasCost, refund } = sponsored!.args as {
      feeToken: `0x${string}`;
      fee: bigint;
      actualGasCost: bigint;
      refund: bigint;
    };
    log(`Sponsored: feeToken=${feeToken} fee=${fee} DAI-units actualGasCost=${actualGasCost} wei refund=${refund} DAI-units`);
    expect(feeToken.toLowerCase()).toBe(dai.address.toLowerCase());
    expect(fee).toBe(result.fee);
    expect(refund).toBeGreaterThan(0n);

    // Refund in DAI to the final recipient; paymaster keeps fee - refund in DAI and paid gas from its ETH deposit.
    expect(await publicClient.readContract({ address: dai.address, abi: erc20Abi, functionName: 'balanceOf', args: [finalRecipient] })).toBe(refund);
    const kept = await publicClient.readContract({ address: dai.address, abi: erc20Abi, functionName: 'balanceOf', args: [h.paymaster] });
    expect(kept).toBe(fee - refund);
    const depositAfter = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });
    expect(depositAfter).toBeLessThan(depositBefore);
    // What it kept in DAI must be worth more than the ETH it spent (margin + service fee) at the signed rate.
    const keptEthEquivalent = (kept * 10n ** 18n) / result.quote.tokenPerEth;
    expect(keptEthEquivalent).toBeGreaterThan(depositBefore - depositAfter);
    log(`paymaster: kept ${kept} DAI-units (~${keptEthEquivalent} wei) for ${depositBefore - depositAfter} wei of gas`);
  });
});
