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
import { mkdirSync, rmdirSync } from 'node:fs';
import { createWalletClient, http, parseEther, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { ensurePaymasterSetup, MemorySponsorshipStore, RelayerService } from '@tornado-4337/relayer';
import { relayerRegistryAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { forgeArtifact } from '../src/deploy.js';
import { nullifierHashHex } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { startHarness, type Harness } from './harness.js';
import { askForSponsorship, shield, sponsorshipRequest, startFailingRpc, startStubBundler } from './sponsorship-request.js';

const log = (m: string) => console.log(`[e2e-refusals] ${m}`);

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
      [
        'result without paymasterPostOpGasLimit',
        async () =>
          Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              callGasLimit: toHex(1n),
              verificationGasLimit: toHex(1n),
              preVerificationGas: toHex(1n),
              paymasterVerificationGasLimit: toHex(1n),
            },
          }),
      ],
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
          paymasterVerificationGasLimit: toHex(1n),
          paymasterPostOpGasLimit: toHex(1n),
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

  it('an estimate where only paymasterPostOpGasLimit exceeds the operation', async () => {
    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const realBundler = h.relayer.config.bundlerUrl;
    // Every other field fits comfortably; postOp needs one gas more than the operation allows. A postOp
    // that runs out of gas reverts the execution after the paymaster has paid, fee transfer included.
    const postOpLimit = BigInt(op.paymasterPostOpGasLimit as Hex);
    const stub = await startStubBundler(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          callGasLimit: toHex(1n),
          verificationGasLimit: toHex(1n),
          preVerificationGas: toHex(1n),
          paymasterVerificationGasLimit: toHex(1n),
          paymasterPostOpGasLimit: toHex(postOpLimit + 1n),
        },
      }),
    );
    (h.relayer.config as { bundlerUrl: string }).bundlerUrl = stub.url;
    try {
      const res = await askForSponsorship(h, op);
      expect(res.result).toBeUndefined();
      expect(res.error!.message).toMatch(new RegExp(`paymasterPostOpGasLimit ${postOpLimit} < ${postOpLimit + 1n}`));
      expect(res.error!.message).not.toMatch(/callGasLimit|verificationGasLimit \d|preVerificationGas/);
      expect(h.relayer.sponsorships.get(nullifierHashHex(note))).toBeUndefined();
    } finally {
      await stub.stop();
      (h.relayer.config as { bundlerUrl: string }).bundlerUrl = realBundler;
    }
  }, 300_000);

  it('a sponsorship it cannot record, and leaves nothing behind that would block the note', async () => {
    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const nullifier = nullifierHashHex(note);
    // The store's write fails for real: its temporary path is a directory.
    const blocker = `${h.sponsorshipFile}.tmp`;
    mkdirSync(blocker);
    try {
      const res = await askForSponsorship(h, op);
      expect(res.result, 'an unrecorded signature must not be issued').toBeUndefined();
      expect(res.error!.message).toMatch(/could not record the sponsorship, not issuing it/);
      expect(h.relayer.sponsorships.get(nullifier), 'no pending residue').toBeUndefined();
    } finally {
      rmdirSync(blocker);
    }
    // The very next request for the same note is signed and recorded.
    const ok = await askForSponsorship(h, op);
    expect(ok.error).toBeUndefined();
    expect(h.relayer.sponsorships.get(nullifier)?.status).toBe('signed');
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

  it('while the registry no longer resolves the worker to the configured master', async () => {
    // The master unregisters the worker while the service is running. A request must be refused at
    // signing — Router -> RelayerRegistry.burn would otherwise revert inside an operation the paymaster
    // pays for — and /status must show the change rather than what start-up saw.
    const reg = h.registry!;
    const { note, leaves } = await shield(h);
    const owner = privateKeyToAccount(generatePrivateKey());
    const { op } = await sponsorshipRequest(h, prover, note, leaves, owner, h.setup.simple7702Implementation);
    const nullifier = nullifierHashHex(note);
    const unregister = [{ type: 'function', name: 'unregisterWorker', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] }] as const;
    await h.impersonated(reg.master, (w) =>
      w.writeContract({ address: reg.relayerRegistry, abi: unregister, functionName: 'unregisterWorker', args: [h.paymaster], chain: h.setup.chain, account: w.account! }),
    );
    try {
      const res = await askForSponsorship(h, op);
      expect(res.result).toBeUndefined();
      expect(res.error!.message).toMatch(/resolves paymaster .* to no relayer, not .*: not signing until the registration is restored/);
      expect(h.relayer.sponsorships.get(nullifier)).toBeUndefined();

      const status = await new RelayerRpc(h.relayerUrl).request<{
        registered: boolean;
        registry: { mode: string; master: Address; modeAtStartup: string; masterAtStartup: Address };
      }>('tornado_status');
      expect(status.registered).toBe(false);
      expect(status.registry.mode).toBe('unregistered');
      expect(status.registry.master).toBe(zeroAddress);
      expect(status.registry.modeAtStartup).toBe('worker');
      expect(status.registry.masterAtStartup.toLowerCase()).toBe(reg.master.toLowerCase());
      log(`unregistered: request refused (${res.error!.message.slice(0, 80)}…), /status mode=${status.registry.mode}`);
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
    // Registered again: the same request is signed, and /status agrees.
    const ok = await askForSponsorship(h, op);
    expect(ok.error).toBeUndefined();
    expect(h.relayer.sponsorships.get(nullifier)?.status).toBe('signed');
    const restored = await new RelayerRpc(h.relayerUrl).request<{ registered: boolean; registry: { mode: string } }>('tornado_status');
    expect(restored.registered).toBe(true);
    expect(restored.registry.mode).toBe('worker');
  }, 300_000);

  it('a node that fails a registry read: start-up stops, /status says unavailable, never a zero fee', async () => {
    const proxy = await startFailingRpc(h.rpcUrl, ['instanceFee(address)']);
    const quiet = { info: () => {}, warn: () => {} };
    const config = () => ({ ...h.relayer.config, rpcUrl: proxy.url, sponsorshipStore: new MemorySponsorshipStore() });
    try {
      // With the FeeManager read failing, the service does not start (it would otherwise report 0 burn).
      await expect(RelayerService.create(config(), quiet)).rejects.toThrow(/injected node failure/);

      // Started while the node was healthy, then the read fails: /status reports it, with the reason.
      proxy.failing = false;
      const service = await RelayerService.create(config(), quiet);
      proxy.failing = true;
      const status = await service.status();
      expect(status.registry.mode).toBeNull();
      expect(status.registry.burnPerWithdraw).toBeNull();
      expect(status.registry.stake).toBeNull();
      expect(status.registered).toBeNull();
      expect(status.unavailable.registry).toMatch(/injected node failure/);
      // The fields that could be read still are.
      expect(status.deposit.wei).not.toBeNull();
      proxy.failing = false;
      const healthy = await service.status();
      expect(healthy.registry.mode).toBe('worker');
      expect(healthy.unavailable).toEqual({});
      // Healthy again, the value is whatever the FeeManager itself returns (a fresh pool's stored fee is
      // zero until the router's first withdrawal updates it — a real zero, read from the chain).
      const feeManagerAbi = [
        { type: 'function', name: 'instanceFee', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint160' }] },
      ] as const;
      const burn = Object.entries(healthy.registry.burnPerWithdraw!).find(([k]) => k.toLowerCase() === h.instance.toLowerCase());
      expect(burn, 'the pool is reported').toBeDefined();
      expect(BigInt(burn![1])).toBe(
        BigInt(await h.publicClient.readContract({ address: h.registry!.feeManager, abi: feeManagerAbi, functionName: 'instanceFee', args: [h.instance] })),
      );
    } finally {
      await proxy.stop();
    }
  }, 300_000);

  it('a start-up that cannot read the worker -> master relationship, or finds another master, before any funding', async () => {
    const reg = h.registry!;
    const cfg = {
      chainId: BigInt(h.setup.chain.id),
      rpcUrl: h.rpcUrl,
      entryPoint: h.setup.entryPoint,
      signerKey: h.relayerSignerKey,
      mode: 'standalone' as const,
      paymaster: h.paymaster,
      router: reg.router,
      rewardAccount: reg.master,
      autoSetup: true,
      stakeWei: parseEther('5'), // more than is staked: a passing preflight would go on to stake
      unstakeDelaySec: 86_400,
      depositWei: parseEther('5'),
      requireRegistration: false,
    };
    const quiet = { info: () => {}, warn: () => {} };
    const before = await h.publicClient.getBalance({ address: h.relayerSigner.address });

    // The registry answers, and names a different master than the one configured.
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    await expect(ensurePaymasterSetup({ ...cfg, rewardAccount: stranger }, quiet)).rejects.toThrow(
      new RegExp(`resolves paymaster ${h.paymaster} to master ${reg.master}, but REWARD_ACCOUNT is ${stranger}`, 'i'),
    );

    // The registry read fails: that is not "not registered yet".
    const proxy = await startFailingRpc(h.rpcUrl, ['workers(address)']);
    try {
      await expect(ensurePaymasterSetup({ ...cfg, rpcUrl: proxy.url }, quiet)).rejects.toThrow(
        /cannot read the worker -> master relationship .*injected node failure.*nothing has been staked or deposited/s,
      );
    } finally {
      await proxy.stop();
    }
    expect(await h.publicClient.getBalance({ address: h.relayerSigner.address })).toBe(before);
  }, 300_000);
});
