/**
 * Drives the real Kohaku SDK (`@kohaku-eth/tornado-cash`, patched with the
 * relayer-signed paymaster mode) against this repo's relayer + paymaster on a
 * Sepolia fork: shield 0.1 ETH with the SDK, then unshield in `paymaster` mode
 * with a tail call that wraps the ETH and supplies it to Aave — one userOp,
 * sponsored by the thin relayer, bundled by alto.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { MemoryStorage, MnemonicKeystore, type Host } from '@kohaku-eth/plugins';
import { viem as viemProvider } from '@kohaku-eth/provider/viem';
import {
  createTCBroadcaster,
  E_ADDRESS,
  TornadoCashConfigs,
  TornadoCashProtocol,
  type TCBroadcaster,
} from '@kohaku-eth/tornado-cash';

/** Shape of a paymaster-mode withdrawal payload (the SDK's IGenericPaymasterWithdrawalPayload). */
interface IGenericPaymasterWithdrawalPayload {
  mode: 'paymaster';
  proof: { proof: Hex; args: [Hex, Hex, Hex, Hex, Hex, Hex] };
  paymasterAddress: Hex;
  entryPointAddress: Hex;
  bundlerUrl: string;
  userOperation: { sender: Address; paymaster?: Hex; paymasterData?: Hex; callData: Hex };
}

import { aavePoolAbi, erc20Abi, loadArtifacts, paymasterAdminAbi, zapAbi } from '@tornado-4337/client';
import { ANVIL_KEYS, startHarness, type Harness } from '@tornado-4337/client/e2e/harness';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(here, '..', 'vendor', 'kohaku', 'packages', 'tornado-cash', 'tests', 'state.11155111.json');
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const CHAIN_ID = 11155111;

const log = (m: string) => console.log(`[kohaku-e2e] ${m}`);

describe('Kohaku SDK -> thin relayer paymaster (Sepolia fork)', () => {
  let h: Harness;
  let protocol: TornadoCashProtocol;
  let broadcaster: TCBroadcaster;

  beforeAll(async () => {
    h = await startHarness({ chainKey: 'sepolia', canonicalInstances: true, log });

    const publicClient = createPublicClient({ chain: h.setup.chain, transport: http(h.rpcUrl), cacheTime: 0 });
    const host: Host = {
      keystore: new MnemonicKeystore(TEST_MNEMONIC),
      storage: new MemoryStorage(),
      network: { fetch },
      provider: viemProvider(publicClient),
    };

    // The only integration point: a `relayer` entry in the chain's paymaster config.
    const paymasterConfig = {
      [CHAIN_ID]: {
        bundlerUrl: h.bundlerUrl,
        entryPointAddress: h.setup.entryPoint,
        paymasterAddress: h.paymaster,
        poolsAccountsMap: {},
        relayer: { url: h.relayerUrl },
      },
    };

    const artifacts = await loadArtifacts();
    protocol = new TornadoCashProtocol(host, {
      protocolConfig: TornadoCashConfigs[CHAIN_ID],
      paymasterConfig,
      initialState: async () => JSON.parse(readFileSync(SNAPSHOT, 'utf8')),
      artifactsLoader: async () => ({ circuitText: artifacts.circuitText, provingKey: artifacts.provingKey }),
    });
    broadcaster = createTCBroadcaster(host, { paymasterConfig });

    log('syncing SDK state from the snapshot ...');
    const t0 = Date.now();
    await protocol.sync();
    log(`synced in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('shields with the SDK, then unshields via the relayer paymaster with an Aave tail call', async () => {
    const { publicClient, setup } = h;
    const nativeAsset = { __type: 'erc20' as const, contract: getAddress(E_ADDRESS) };
    const AMOUNT = parseEther('0.1');

    // --- shield ------------------------------------------------------------------
    const alice = privateKeyToAccount(ANVIL_KEYS[4]!);
    await h.setBalance(alice.address, parseEther('10'));
    const aliceWallet = createWalletClient({ account: alice, chain: setup.chain, transport: http(h.rpcUrl) });
    const { txns } = await protocol.prepareShield({ asset: nativeAsset, amount: AMOUNT });
    for (const tx of txns) {
      const hash = await aliceWallet.sendTransaction({
        to: tx.to as Address,
        data: tx.data as Hex,
        value: tx.value,
        gas: 2_000_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
    }
    await h.mine(1);
    const [{ amount: shielded }] = await protocol.balance([nativeAsset]);
    expect(shielded).toBe(AMOUNT);
    log(`shielded ${shielded} wei`);

    // --- unshield via relayer paymaster + tail call (wrap + Aave supply) ---------
    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const aaveWeth = setup.aaveWeth ?? setup.weth;
    const reserve = await publicClient.readContract({
      address: setup.aavePool,
      abi: aavePoolAbi,
      functionName: 'getReserveData',
      args: [aaveWeth],
    });
    const depositBefore = await publicClient.readContract({
      address: h.paymaster,
      abi: paymasterAdminAbi,
      functionName: 'getDeposit',
    });

    const op = await protocol.prepareUnshield({ asset: nativeAsset, amount: AMOUNT }, finalRecipient, {
      mode: 'paymaster',
      tailCallsGasEstimate: 250_000n,
      tailCalls: async (_sender, ctx) => [
        {
          to: h.zap,
          value: ctx!.amount!,
          data: encodeFunctionData({ abi: zapAbi, functionName: 'wrapEthAndSupply', args: [finalRecipient] }),
        },
      ],
    });
    expect(op.withdrawals).toHaveLength(1);
    const w = op.withdrawals[0]! as IGenericPaymasterWithdrawalPayload;
    expect(w.mode).toBe('paymaster');
    expect(w.paymasterAddress.toLowerCase()).toBe(h.paymaster.toLowerCase());
    expect(w.userOperation.paymaster?.toLowerCase()).toBe(h.paymaster.toLowerCase());
    const fee = BigInt(w.proof.args[4]);
    expect(w.proof.args[3].toLowerCase()).toBe(h.paymaster.toLowerCase());
    log(`prepared userOp sender=${w.userOperation.sender} fee=${fee}`);

    const results = await broadcaster.broadcast(op);
    expect(results).toHaveLength(1);
    await h.mine(1);
    log(`userOp ${results[0]!.id} mined`);

    // --- assertions --------------------------------------------------------------
    const [{ amount: remaining }] = await protocol.balance([nativeAsset]);
    expect(remaining).toBe(0n);

    const aBalance = await publicClient.readContract({
      address: reserve.aTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [finalRecipient],
    });
    log(`aWETH balance of ${finalRecipient}: ${aBalance} (expected >= ${AMOUNT - fee})`);
    expect(aBalance).toBeGreaterThanOrEqual(AMOUNT - fee);
    expect(await publicClient.getBalance({ address: w.userOperation.sender })).toBe(0n);

    const refund = await publicClient.getBalance({ address: finalRecipient });
    log(`refund to final recipient: ${refund}`);
    expect(refund).toBeGreaterThan(0n);

    const depositAfter = await publicClient.readContract({
      address: h.paymaster,
      abi: paymasterAdminAbi,
      functionName: 'getDeposit',
    });
    expect(depositAfter).toBeGreaterThan(depositBefore);

    const receipt = await publicClient.getTransactionReceipt({ hash: results[0]!.id as Hex }).catch(() => undefined);
    if (receipt) {
      const sponsored = receipt.logs
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
    }
  });
});
