/**
 * Strict-bundler acceptance: the operation the SDK/relayer produce is accepted by a bundler running in
 * *safe mode* (ERC-7562 tracing on: every op is traced and checked against the mempool rules before it
 * is accepted), bundled, included, and reported back through `eth_getUserOperationReceipt`.
 *
 * Runs on a throwaway geth `--dev` chain (e2e/geth-dev.ts): canonical EntryPoint v0.8 and
 * Simple7702Account at their real addresses, a fresh Tornado pool, the sandbox DAO (mainnet
 * RelayerRegistry logic) with a registered master whose worker is the relayer software's own contract —
 * every step a real transaction. geth is used because both strict validators are written against it:
 *
 *   reference  eth-infinitism's bundler at the pinned commit (src/aa-bundler.ts), safe mode with geth's
 *              native `erc7562Tracer`. Needs AA_BUNDLER_DIR. The default.
 *   alto-safe  pimlico's alto with `--safe-mode` (its own ERC-7562 collector tracer). Opt-in, see below.
 *
 * The same run carries the adversarial case: the very same relayer-signed op, with only its EIP-7702
 * authorization swapped to another (byte-identical) Simple7702Account deployment, is refused by the
 * bundler's validation with the paymaster's SenderImplementationMismatch before the original goes in.
 *
 *   AA_BUNDLER_DIR=…/bundler npx vitest run e2e/strict-bundler.test.ts        (geth >= 1.15 on PATH)
 *
 * Gas is sent at the relayer's quoted ceilings (skipEstimation): the reference bundler's estimator runs
 * callData standalone, which cannot price a withdrawal whose sponsorship is granted during validation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  concatHex,
  createWalletClient,
  decodeEventLog,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { relayerRegistryAbi, tornadoAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { gethAvailable, startGethDevHarness, type GethDevHarness } from './geth-dev.js';
import { freePort } from './harness.js';

const log = (m: string) => console.log(`[e2e-strict] ${m}`);
/** `SenderImplementationMismatch(address,address)` */
const SENDER_IMPLEMENTATION_MISMATCH = '0x77fb16e0';

type JsonRpc = { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown[] };
type JsonRpcResult = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const body = await rpcRaw(url, { jsonrpc: '2.0', id: 1, method, params });
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

async function rpcRaw(url: string, req: JsonRpc): Promise<JsonRpcResult> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  return (await res.json()) as JsonRpcResult;
}

/**
 * A pass-through JSON-RPC proxy in front of the bundler that hands every `eth_sendUserOperation` to
 * `onSend` first (the adversarial step) and forwards the original afterwards.
 */
async function bundlerProxy(upstream: string, onSend: (op: Record<string, unknown>) => Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const port = await freePort();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw) as JsonRpc;
      try {
        if (body.method === 'eth_sendUserOperation') await onSend(body.params![0] as Record<string, unknown>);
        const upstreamRes = await rpcRaw(upstream, body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...upstreamRes }));
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: (err as Error).message } }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Default: the reference bundler (needs AA_BUNDLER_DIR). `STRICT_BUNDLERS=reference,alto-safe` adds alto:
 * with alto <= 0.0.21 its safe-mode simulation of an EntryPoint v0.8 op bubbles the EntryPoint's
 * `DelegateAndRevert` wrapper, which alto does not decode ("0x99410554 not found on ABI"), on geth and
 * anvil alike — so it is opt-in until alto fixes that.
 */
const BUNDLERS = (process.env.STRICT_BUNDLERS ?? 'reference').split(',') as ('alto-safe' | 'reference')[];
const ready = gethAvailable() && (BUNDLERS.every((b) => b !== 'reference') || !!process.env.AA_BUNDLER_DIR);

describe.skipIf(!ready).each(BUNDLERS)('%s bundler in safe mode accepts and includes the sponsored op', (bundler) => {
  let h: GethDevHarness;
  let prover: TornadoProver;

  beforeAll(async () => {
    h = await startGethDevHarness({ bundler, log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
  }, 600_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('rejects the op with a swapped 7702 implementation, then accepts, bundles and includes the original', async () => {
    expect(h.bundler).toBe(bundler);
    const { publicClient, setup } = h;
    const supported = await rpc<string[]>(h.bundlerUrl, 'eth_supportedEntryPoints');
    expect(supported.map((e) => e.toLowerCase())).toContain(setup.entryPoint.toLowerCase());
    if (bundler === 'reference') {
      // Safe mode: the bundler's merged configuration says so, and no tracerRpcUrl = geth's native tracer.
      expect(h.bundlerOutput()).toMatch(/"unsafe":false/);
      expect(h.bundlerOutput()).not.toMatch(/tracerRpcUrl/);
    }

    // Shield a note.
    const depositor = await h.newFundedAccount(parseEther('10'));
    const depositorWallet = createWalletClient({ account: depositor, chain: setup.chain, transport: http(h.rpcUrl) });
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

    // Another Simple7702Account deployment: the canonical initCode through the deterministic deployer
    // under a different salt — same code, different address, a valid authorization target the relayer
    // never signed for.
    const { deterministicDeployer, simple7702Account } = h.canonical;
    const otherSalt = keccak256(toHex('tornado-4337 other Simple7702Account'));
    const otherImplementation = getContractAddress({ opcode: 'CREATE2', from: deterministicDeployer, salt: otherSalt, bytecode: simple7702Account.initCode });
    await publicClient.waitForTransactionReceipt({
      hash: await depositorWallet.sendTransaction({ to: deterministicDeployer, data: concatHex([otherSalt, simple7702Account.initCode]) }),
    });
    expect(await publicClient.getCode({ address: otherImplementation })).toBe(await publicClient.getCode({ address: setup.simple7702Implementation }));

    const owner = privateKeyToAccount(generatePrivateKey());
    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const master = h.registry!.master;
    const stakeBefore = await publicClient.readContract({
      address: h.registry!.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [master],
    });

    // The adversarial step runs on the exact op the SDK/relayer produced, right before it is sent.
    const rejections: string[] = [];
    const proxy = await bundlerProxy(h.bundlerUrl, async (op) => {
      const auth = op.eip7702Auth as { address: Address; chainId: Hex; nonce: Hex } | undefined;
      expect(auth?.address.toLowerCase()).toBe(setup.simple7702Implementation.toLowerCase());
      const swapped = await owner.signAuthorization({ address: otherImplementation, chainId: setup.chain.id, nonce: Number(auth!.nonce) });
      const tampered = {
        ...op,
        eip7702Auth: { address: otherImplementation, chainId: toHex(swapped.chainId), nonce: toHex(swapped.nonce), r: swapped.r, s: swapped.s, yParity: toHex(swapped.yParity!) },
      };
      const res = await rpcRaw(h.bundlerUrl, { jsonrpc: '2.0', id: 7, method: 'eth_sendUserOperation', params: [tampered, setup.entryPoint] });
      expect(res.result).toBeUndefined();
      const detail = `${res.error?.message ?? ''} ${JSON.stringify(res.error?.data ?? '')}`;
      rejections.push(detail);
      log(`tampered op rejected: ${detail.slice(0, 200)}`);
    });

    let result;
    try {
      result = await sponsoredWithdraw({
        publicClient,
        chain: setup.chain,
        bundlerUrl: proxy.url,
        relayerUrl: h.relayerUrl,
        instance: h.instance,
        note,
        leaves,
        prover,
        owner,
        refundTo: finalRecipient,
        tailCallsGas: 60_000n,
        tailCalls: ({ amount }) => [{ to: finalRecipient, value: amount, data: '0x' as Hex }],
        skipEstimation: true,
        log,
      });
    } finally {
      await proxy.close();
    }
    expect(result.receipt.success).toBe(true);

    // The swap was refused by the paymaster's validation (AA33 = paymaster reverted), for that reason.
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatch(/AA33/);
    expect(rejections[0]!.toLowerCase()).toContain(SENDER_IMPLEMENTATION_MISMATCH.slice(2));

    // The bundler's own view of the inclusion.
    const bundlerReceipt = await rpc<{ success: boolean; sender: Address; paymaster?: Address; receipt: { transactionHash: Hex; blockNumber: Hex } }>(
      h.bundlerUrl,
      'eth_getUserOperationReceipt',
      [result.userOpHash],
    );
    expect(bundlerReceipt.success).toBe(true);
    expect(bundlerReceipt.sender.toLowerCase()).toBe(owner.address.toLowerCase());
    // (the reference bundler leaves `paymaster` out of its receipt; alto fills it)
    if (bundlerReceipt.paymaster) expect(bundlerReceipt.paymaster.toLowerCase()).toBe(h.paymaster.toLowerCase());
    const tx = await publicClient.getTransactionReceipt({ hash: bundlerReceipt.receipt.transactionHash });
    expect(tx.status).toBe('success');
    expect(tx.to?.toLowerCase()).toBe(setup.entryPoint.toLowerCase());

    // On-chain effects: note spent, recipient paid, master stake burned through the router.
    expect(
      await publicClient.readContract({ address: h.instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] }),
    ).toBe(true);
    expect(await publicClient.getBalance({ address: finalRecipient })).toBe(h.denomination - result.fee);
    const burned = tx.logs
      .filter((l) => l.address.toLowerCase() === h.registry!.relayerRegistry.toLowerCase())
      .flatMap((l) => {
        try {
          return [decodeEventLog({ abi: relayerRegistryAbi, data: l.data, topics: l.topics })];
        } catch {
          return [];
        }
      })
      .find((e) => e.eventName === 'StakeBurned');
    expect(burned).toBeDefined();
    const amountBurned = (burned!.args as { amountBurned: bigint }).amountBurned;
    const stakeAfter = await publicClient.readContract({
      address: h.registry!.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [master],
    });
    expect(stakeAfter).toBe(stakeBefore - amountBurned);
    log(`userOp ${result.userOpHash} included in ${bundlerReceipt.receipt.transactionHash} (block ${Number(bundlerReceipt.receipt.blockNumber)}), burn ${amountBurned}`);
  }, 600_000);
});
