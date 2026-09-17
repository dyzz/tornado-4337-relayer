/**
 * The complete flow on a mainnet fork with the persistence an operator runs — a file-backed
 * sponsorship store — across a relayer restart.
 *
 * Before the restart: a withdrawal -> swap-free forward, through the live DAO router, is sponsored and
 * included, and its sponsorship is on disk with its nonce and gas cost. After the restart the new
 * service has read that file back: the same note is still refused, `/status` still budgets the live
 * sponsorship, and a fresh note goes through end to end on the restarted service.
 *
 *   MAINNET_RPC_URL=… npx vitest run e2e/relayer-restart.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWalletClient, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { relayerRegistryAbi, tornadoAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex, type Note } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { startHarness, type Harness } from './harness.js';
import { askForSponsorship, sponsorshipRequest } from './sponsorship-request.js';

const log = (m: string) => console.log(`[e2e-restart] ${m}`);

type LiveStatus = { deposit: { committedWei: Hex | null; accepting: boolean }; registered: boolean; unavailable: Record<string, string> };

describe('a relayer with a file-backed store, across a restart', () => {
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

  async function shieldNote(): Promise<{ note: Note; leaves: (bigint | string)[] }> {
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
    const { leaves } = await syncLeaves(h.publicClient, h.instance, { fromBlock: h.instanceDeployBlock, toBlock: receipt.blockNumber, log });
    return { note, leaves };
  }

  async function withdraw(note: Note, leaves: (bigint | string)[], finalRecipient: Address) {
    const result = await sponsoredWithdraw({
      publicClient: h.publicClient,
      chain: h.setup.chain,
      bundlerUrl: h.bundlerUrl,
      relayerUrl: h.relayerUrl,
      instance: h.instance,
      note,
      leaves,
      prover,
      owner: privateKeyToAccount(generatePrivateKey()),
      refundTo: finalRecipient,
      tailCallsGas: 60_000n,
      tailCalls: ({ amount }) => [{ to: finalRecipient, value: amount, data: '0x' as Hex }],
      log,
    });
    expect(result.receipt.success).toBe(true);
    expect(
      await h.publicClient.readContract({ address: h.instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] }),
    ).toBe(true);
    expect(await h.publicClient.getBalance({ address: finalRecipient })).toBe(h.denomination - result.fee);
    return result;
  }

  const status = () => new RelayerRpc(h.relayerUrl).request<LiveStatus>('tornado_status');

  it('keeps one sponsorship per note and its gas budget through the restart, and keeps serving', async () => {
    const reg = h.registry!;
    const stakeBefore = await h.publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [reg.master],
    });

    // 1. A complete withdrawal through the relayer, recorded on disk.
    const first = await shieldNote();
    const nh1 = nullifierHashHex(first.note);
    const r1 = await withdraw(first.note, first.leaves, privateKeyToAccount(generatePrivateKey()).address);
    const recorded = h.relayer.sponsorships.get(nh1)!;
    expect(recorded.status).toBe('signed');
    expect(recorded.maxGasCostWei).toBeGreaterThan(0n);
    const onDisk = JSON.parse(readFileSync(h.sponsorshipFile, 'utf8'))[nh1];
    expect(onDisk).toMatchObject({
      status: 'signed',
      nonce: recorded.nonce.toString(),
      maxGasCostWei: recorded.maxGasCostWei!.toString(),
      validUntil: recorded.validUntil,
    });
    const s1 = await status();
    expect(s1.unavailable).toEqual({});
    expect(BigInt(s1.deposit.committedWei!)).toBe(recorded.maxGasCostWei);
    log(`withdrawal 1 in ${r1.receipt.receipt.transactionHash}; sponsorship on disk, ${recorded.maxGasCostWei} wei budgeted`);

    // 2. Restart: a new service reads the file back.
    await h.restartRelayer();
    const restored = h.relayer.sponsorships.get(nh1)!;
    expect(restored).toMatchObject({
      status: 'signed',
      sender: recorded.sender,
      nonce: recorded.nonce,
      validUntil: recorded.validUntil,
      maxGasCostWei: recorded.maxGasCostWei,
    });
    const s2 = await status();
    expect(s2.unavailable).toEqual({});
    expect(s2.registered).toBe(true);
    expect(s2.deposit.accepting).toBe(true);
    expect(BigInt(s2.deposit.committedWei!)).toBe(recorded.maxGasCostWei);

    // 3. The same note is still refused by the restarted service — a restart is not a second chance.
    const dup = await sponsorshipRequest(h, prover, first.note, first.leaves, privateKeyToAccount(generatePrivateKey()), h.setup.simple7702Implementation);
    const refused = await askForSponsorship(h, dup.op);
    expect(refused.result).toBeUndefined();
    expect(refused.error!.message).toMatch(/note already sponsored/);

    // 4. A fresh note goes through end to end on the restarted service, and both sponsorships are
    //    budgeted while they are live.
    const second = await shieldNote();
    const nh2 = nullifierHashHex(second.note);
    const r2 = await withdraw(second.note, second.leaves, privateKeyToAccount(generatePrivateKey()).address);
    const recorded2 = h.relayer.sponsorships.get(nh2)!;
    const s3 = await status();
    expect(BigInt(s3.deposit.committedWei!)).toBe(recorded.maxGasCostWei! + recorded2.maxGasCostWei!);
    expect(Object.keys(JSON.parse(readFileSync(h.sponsorshipFile, 'utf8'))).sort()).toEqual([nh1, nh2].sort());

    // Both withdrawals burned the master's stake through the router, as any relayed withdrawal does.
    const stakeAfter = await h.publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [reg.master],
    });
    expect(stakeAfter).toBeLessThan(stakeBefore);
    log(`withdrawal 2 in ${r2.receipt.receipt.transactionHash} after the restart; master stake ${stakeBefore} -> ${stakeAfter}`);
  }, 900_000);
});
