/**
 * The failure paths of a sponsorship request, on a mainnet fork against the live DAO stack.
 *
 * Every case here must be refused *before* the relayer signs: once a signature exists the paymaster can
 * be charged for the operation, so "we would have caught it later" is not a defence. Each test therefore
 * asserts both the refusal and that no sponsorship was recorded for the note, which leaves the note free
 * for a later, legitimate request.
 *
 *   MAINNET_RPC_URL=… npx vitest run e2e/relayer-refusals.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { delegationCode, ensurePaymasterSetup, RelayerService } from '@tornado-4337/relayer';
import { paymasterAdminAbi, relayerRegistryAbi, tornadoAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { forgeArtifact } from '../src/deploy.js';
import { merklePath, syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex, type Note } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { startHarness, type Harness } from './harness.js';

const log = (m: string) => console.log(`[e2e-refusals] ${m}`);

/** Shield a note into the harness pool and return it with the pool's leaves. */
async function shield(h: Harness): Promise<{ note: Note; leaves: (bigint | string)[] }> {
  const depositor = await h.newFundedAccount(parseEther('10'));
  const wallet = createWalletClient({ account: depositor, chain: h.setup.chain, transport: http(h.rpcUrl) });
  const note = createNote();
  const hash = await wallet.writeContract({
    address: h.instance,
    abi: tornadoAbi,
    functionName: 'deposit',
    args: [commitmentHex(note)],
    value: h.denomination,
  });
  const receipt = await h.publicClient.waitForTransactionReceipt({ hash });
  // Sync up to the deposit's own block: the node's reported head can still lag the receipt.
  const { leaves } = await syncLeaves(h.publicClient, h.instance, {
    fromBlock: h.instanceDeployBlock,
    toBlock: receipt.blockNumber,
    log,
  });
  return { note, leaves };
}

/**
 * A complete, valid sponsorship request for `note`, as the client would build it: a real proof naming
 * `sender` as recipient and the master as relayer, wrapped in the account's `executeBatch` calldata.
 * `senderImplementation` decides what the op's EIP-7702 authorization points at.
 */
async function sponsorshipRequest(
  h: Harness,
  prover: TornadoProver,
  note: Note,
  leaves: (bigint | string)[],
  owner: ReturnType<typeof privateKeyToAccount>,
  senderImplementation: Address,
): Promise<{ op: Record<string, unknown>; fee: bigint }> {
  const rpc = new RelayerRpc(h.relayerUrl);
  const quote = await rpc.quote({ instance: h.instance, tailCallsGas: 60_000n });
  const path = merklePath(leaves, note.commitment);
  const proof = await prover.prove({
    nullifier: note.nullifier,
    secret: note.secret,
    pathElements: path.pathElements,
    pathIndices: path.pathIndices,
    root: path.root,
    nullifierHash: note.nullifierHash,
    recipient: BigInt(owner.address),
    relayer: BigInt(quote.relayer),
    fee: quote.fee,
    refund: 0n,
  });
  const [root, nullifierHash, recipient, relayerArg, feeArg] = proof.args;
  const withdraw = {
    target: h.paymaster,
    value: 0n,
    data: encodeFunctionData({
      abi: paymasterAdminAbi,
      functionName: 'relayWithdraw',
      args: [h.instance, proof.proof, root, nullifierHash, recipient, relayerArg, BigInt(feeArg)],
    }),
  };
  const callData = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'executeBatch',
        stateMutability: 'nonpayable',
        inputs: [
          {
            name: 'calls',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
          },
        ],
        outputs: [],
      },
    ],
    functionName: 'executeBatch',
    args: [[withdraw]],
  });
  const authorization = await owner.signAuthorization({
    address: senderImplementation,
    chainId: h.setup.chain.id,
    nonce: await h.publicClient.getTransactionCount({ address: owner.address }),
  });
  return {
    fee: quote.fee,
    op: {
      sender: owner.address,
      nonce: toHex(0n),
      factory: '0x7702',
      callData,
      callGasLimit: toHex(quote.gas.callGasLimit),
      verificationGasLimit: toHex(quote.gas.verificationGasLimit),
      preVerificationGas: toHex(quote.gas.preVerificationGas),
      paymasterVerificationGasLimit: toHex(quote.gas.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: toHex(quote.gas.paymasterPostOpGasLimit),
      maxFeePerGas: toHex(quote.maxFeePerGas),
      maxPriorityFeePerGas: toHex(quote.maxPriorityFeePerGas),
      eip7702Auth: {
        address: senderImplementation,
        chainId: toHex(authorization.chainId),
        nonce: toHex(authorization.nonce),
        r: authorization.r,
        s: authorization.s,
        yParity: toHex(authorization.yParity!),
      },
    },
  };
}

/** `pm_getPaymasterData` as a client would call it, returning the JSON-RPC error when refused. */
async function askForSponsorship(h: Harness, op: Record<string, unknown>) {
  const res = await fetch(h.relayerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [op, h.setup.entryPoint, toHex(BigInt(h.setup.chain.id)), {}],
    }),
  });
  return (await res.json()) as { result?: { paymasterData?: Hex }; error?: { code: number; message: string } };
}

describe('the relayer refuses to sign', () => {
  let h: Harness;
  let prover: TornadoProver;

  beforeAll(async () => {
    h = await startHarness({ chainKey: 'mainnet', registry: 'worker', erc20: false, log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
  }, 900_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('an account implementation that is not on the allowlist, even with perfectly valid withdrawal calldata', async () => {
    // An implementation that passes validation and then ignores the calls it was given. The withdrawal
    // in the callData is real, the proof verifies, the fee covers the gas — and the operation would still
    // spend the paymaster's deposit without spending the note or paying the relayer.
    const deployer = await h.newFundedAccount(parseEther('10'));
    const wallet = createWalletClient({ account: deployer, chain: h.setup.chain, transport: http(h.rpcUrl) });
    const artifact = forgeArtifact('contracts', 'NonExecutingAccount.sol', 'NonExecutingAccount');
    const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [] });
    const evil = (await h.publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;

    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, evil);

    const res = await askForSponsorship(h, op);
    expect(res.result).toBeUndefined();
    expect(res.error!.message).toMatch(/not sponsored by this relayer/);
    expect(res.error!.message.toLowerCase()).toContain(evil.toLowerCase());
    // Nothing was reserved: the note is still free for a legitimate request.
    expect(h.relayer.sponsorships.get(nullifierHashHex(note))).toBeUndefined();
    log(`refused the non-executing account ${evil}: ${res.error!.message}`);

    // The very same note and request through the canonical Simple7702Account is signed.
    const good = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const ok = await askForSponsorship(h, good.op);
    expect(ok.error).toBeUndefined();
    expect(ok.result!.paymasterData).toMatch(/^0x[0-9a-f]+$/);
    expect(h.relayer.sponsorships.get(nullifierHashHex(note))?.status).toBe('signed');
  }, 300_000);

  it('a bundler that times out, errors, or answers without a usable estimate', async () => {
    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const nullifier = nullifierHashHex(note);
    const realBundler = h.relayer.config.bundlerUrl;

    for (const [label, handler] of [
      ['timeout', async () => new Promise<Response>(() => {})],
      ['HTTP 500', async () => new Response('nope', { status: 500 })],
      ['JSON-RPC error', async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32521, message: 'AA33 reverted' } })],
      ['empty result', async () => Response.json({ jsonrpc: '2.0', id: 1 })],
      ['result without gas fields', async () => Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } })],
    ] as const) {
      const stub = await startStubBundler(handler);
      (h.relayer.config as { bundlerUrl: string }).bundlerUrl = stub.url;
      (h.relayer.config as { bundlerTimeoutMs?: number }).bundlerTimeoutMs = 1_500;
      try {
        const res = await askForSponsorship(h, op);
        expect(res.result, `${label} must not be signed`).toBeUndefined();
        expect(res.error!.message).toMatch(/bundler simulation|no usable gas estimate/i);
        // The reservation made for this attempt was released again.
        expect(h.relayer.sponsorships.get(nullifier), `${label} must not hold the note`).toBeUndefined();
        log(`${label}: ${res.error!.message.slice(0, 120)}`);
      } finally {
        await stub.stop();
      }
    }

    // The real bundler still signs the same request afterwards.
    (h.relayer.config as { bundlerUrl: string }).bundlerUrl = realBundler;
    (h.relayer.config as { bundlerTimeoutMs?: number }).bundlerTimeoutMs = undefined;
    const ok = await askForSponsorship(h, op);
    expect(ok.error).toBeUndefined();
    expect(h.relayer.sponsorships.get(nullifier)?.status).toBe('signed');
  }, 300_000);

  it('an operation whose gas limits exceed what the bundler estimates it needs', async () => {
    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const realBundler = h.relayer.config.bundlerUrl;
    // An estimate that does not fit the limits the operation carries: the relayer must not sign and
    // then hope, it refuses so the caller re-quotes at the higher limits.
    const stub = await startStubBundler(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          callGasLimit: toHex(50_000_000n),
          verificationGasLimit: toHex(100_000n),
          preVerificationGas: toHex(60_000n),
        },
      }),
    );
    (h.relayer.config as { bundlerUrl: string }).bundlerUrl = stub.url;
    try {
      const res = await askForSponsorship(h, op);
      expect(res.result).toBeUndefined();
      expect(res.error!.message).toMatch(/does not fit the operation's gas limits/);
      expect(h.relayer.sponsorships.get(nullifierHashHex(note))).toBeUndefined();
    } finally {
      await stub.stop();
      (h.relayer.config as { bundlerUrl: string }).bundlerUrl = realBundler;
    }
  }, 300_000);

  it('once the EntryPoint deposit cannot cover the sponsorships already promised', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const first = await shield(h);
    const req = await sponsorshipRequest(h, prover, first.note, first.leaves, owner, h.setup.simple7702Implementation);

    // A reserve just under the current deposit: one sponsorship's worth of gas no longer fits.
    const deposit = await h.relayer.depositWei();
    const original = h.relayer.config.minDepositWei;
    (h.relayer.config as { minDepositWei?: bigint }).minDepositWei = deposit;
    try {
      const res = await askForSponsorship(h, req.op);
      expect(res.result).toBeUndefined();
      expect(res.error!.message).toMatch(/not accepting new sponsorships until the deposit is topped up/);
      expect(h.relayer.sponsorships.get(nullifierHashHex(first.note))).toBeUndefined();
      // /status says so too, and stays answerable.
      const status = await new RelayerRpc(h.relayerUrl).request<{ deposit: { accepting: boolean; wei: Hex } }>('tornado_status');
      expect(status.deposit.accepting).toBe(false);
      log(`deposit ${deposit} wei, reserve ${deposit} wei: refusing`);
    } finally {
      (h.relayer.config as { minDepositWei?: bigint }).minDepositWei = original;
    }

    // Restored budget, same request, signed.
    const ok = await askForSponsorship(h, req.op);
    expect(ok.error).toBeUndefined();
    const status = await new RelayerRpc(h.relayerUrl).request<{ deposit: { accepting: boolean; committedWei: Hex } }>('tornado_status');
    expect(status.deposit.accepting).toBe(true);
    // The signed sponsorship is counted against the budget while it is live.
    expect(BigInt(status.deposit.committedWei)).toBeGreaterThan(0n);
  }, 300_000);

  it('a per-operation gas cap smaller than the operation', async () => {
    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const original = h.relayer.config.maxSponsorshipGasWei;
    (h.relayer.config as { maxSponsorshipGasWei?: bigint }).maxSponsorshipGasWei = 1n;
    try {
      const res = await askForSponsorship(h, op);
      expect(res.result).toBeUndefined();
      expect(res.error!.message).toMatch(/above the per-operation limit/);
      expect(h.relayer.sponsorships.get(nullifierHashHex(note))).toBeUndefined();
    } finally {
      (h.relayer.config as { maxSponsorshipGasWei?: bigint }).maxSponsorshipGasWei = original;
    }
  }, 300_000);

  it('a paymaster whose sponsorship-terms layout predates this software, before it stakes or funds anything', async () => {
    // A contract that is a paymaster but answers with a different paymasterAndData length: the shape of
    // an upgrade that has already happened once. The setup step must refuse it while it is still only
    // reading, so no stake or deposit is spent on a contract that cannot parse our sponsorships.
    const deployer = await h.newFundedAccount(parseEther('10'));
    const wallet = createWalletClient({ account: deployer, chain: h.setup.chain, transport: http(h.rpcUrl) });
    const artifact = forgeArtifact('contracts', 'LegacyLayoutPaymaster.sol', 'LegacyLayoutPaymaster');
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [h.setup.entryPoint, h.relayerSigner.address],
    });
    const legacy = (await h.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;

    const before = await h.publicClient.getBalance({ address: h.relayerSigner.address });
    await expect(
      ensurePaymasterSetup(
        {
          chainId: BigInt(h.setup.chain.id),
          rpcUrl: h.rpcUrl,
          entryPoint: h.setup.entryPoint,
          signerKey: h.relayerSignerKey,
          mode: 'standalone',
          paymaster: legacy,
          autoSetup: true,
          stakeWei: parseEther('1'),
          unstakeDelaySec: 86_400,
          depositWei: parseEther('1'),
          requireRegistration: false,
        },
        { info: () => {}, warn: () => {} },
      ),
    ).rejects.toThrow(/encodes paymasterAndData as \d+ bytes, this software produces 317/);
    // Not one wei left the relayer key.
    expect(await h.publicClient.getBalance({ address: h.relayerSigner.address })).toBe(before);
  }, 300_000);

  it('a wrong EntryPoint, signing key or router, also before any funding', async () => {
    const cfg = {
      chainId: BigInt(h.setup.chain.id),
      rpcUrl: h.rpcUrl,
      entryPoint: h.setup.entryPoint,
      signerKey: h.relayerSignerKey,
      mode: 'standalone' as const,
      paymaster: h.paymaster,
      autoSetup: true,
      stakeWei: parseEther('1'),
      unstakeDelaySec: 86_400,
      depositWei: parseEther('1'),
      requireRegistration: false,
    };
    const quiet = { info: () => {}, warn: () => {} };
    const before = await h.publicClient.getBalance({ address: h.relayerSigner.address });

    await expect(ensurePaymasterSetup({ ...cfg, entryPoint: '0x0000000000000000000000000000000000000E01' }, quiet)).rejects.toThrow(
      /bound to EntryPoint/,
    );
    await expect(ensurePaymasterSetup({ ...cfg, signerKey: generatePrivateKey() }, quiet)).rejects.toThrow(/expects signatures from/);
    await expect(ensurePaymasterSetup({ ...cfg, router: '0x0000000000000000000000000000000000000R01'.replace('R', 'a') as Address }, quiet)).rejects.toThrow(
      /routes withdrawals through/,
    );
    await expect(ensurePaymasterSetup({ ...cfg, chainId: 424242n }, quiet)).rejects.toThrow(/chain id/);
    await expect(ensurePaymasterSetup({ ...cfg, mode: '7702' }, quiet)).rejects.toThrow(/PAYMASTER_MODE=7702 is not supported/);
    expect(await h.publicClient.getBalance({ address: h.relayerSigner.address })).toBe(before);
  }, 300_000);

  it('when the registry no longer resolves the worker to the configured master', async () => {
    // The master unregisters the worker while the service is running: /status must show it, rather than
    // repeating what was true at start-up.
    const reg = h.registry!;
    await h.impersonated(reg.master, (w) =>
      w.writeContract({
        address: reg.relayerRegistry,
        abi: [{ type: 'function', name: 'unregisterWorker', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] }] as const,
        functionName: 'unregisterWorker',
        args: [h.paymaster],
        chain: h.setup.chain,
        account: w.account!,
      }),
    );
    try {
      const status = await new RelayerRpc(h.relayerUrl).request<{
        registry: { mode: string; master: Address; masterAtStartup: Address };
      }>('tornado_status');
      expect(status.registry.mode).toBe('unregistered');
      expect(status.registry.masterAtStartup.toLowerCase()).toBe(reg.master.toLowerCase());
      expect(status.registry.master).not.toBe(status.registry.masterAtStartup);
      log(`registry change visible in /status: ${status.registry.mode}`);
    } finally {
      await h.impersonated(reg.master, (w) =>
        w.writeContract({
          address: reg.relayerRegistry,
          abi: relayerRegistryAbi,
          functionName: 'registerWorker',
          args: [reg.master, h.paymaster],
          chain: h.setup.chain,
          account: w.account!,
        }),
      );
    }
    const restored = await new RelayerRpc(h.relayerUrl).request<{ registry: { mode: string } }>('tornado_status');
    expect(restored.registry.mode).toBe('worker');
  }, 300_000);
});

/** A one-request JSON-RPC server standing in for the bundler. */
async function startStubBundler(handler: () => Promise<Response>): Promise<{ url: string; stop(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const { freePort } = await import('./harness.js');
  const port = await freePort();
  const server = createServer(async (_req, res) => {
    const out = await handler();
    const body = await out.text();
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') ?? 'text/plain' }).end(body);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
