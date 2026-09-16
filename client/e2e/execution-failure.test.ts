/**
 * What a *failed execution* actually costs, on a mainnet fork against the live DAO stack.
 *
 * A UserOperation that passes validation and then reverts during execution is still included and still
 * billed to the paymaster. Nothing about the sponsorship design changes that, and this test exists to
 * state the boundary precisely rather than imply that pre-signing checks remove it:
 *
 * The tail call here succeeds when the relayer simulates it and reverts once the operation is actually
 * executed, because a plain transaction arms it in between. That is the residual risk stated plainly:
 * chain state moves between signature and inclusion, and no pre-signing simulation closes that window.
 *
 *   - the withdrawal, the nullifier, the fee to the master and the TORN burn all revert together,
 *     because they happen inside the same execution frame as the tail call;
 *   - the gas is not refunded: the paymaster's EntryPoint deposit pays for the whole attempt;
 *   - the sender's EntryPoint nonce and its EIP-7702 delegation do *not* revert, so a retry from the
 *     same deterministic sender must read both from the chain rather than assume they are untouched.
 *
 *   MAINNET_RPC_URL=… npx vitest run e2e/execution-failure.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, decodeEventLog, encodeFunctionData, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { delegationCode } from '@tornado-4337/relayer';
import { paymasterAdminAbi, relayerRegistryAbi, tornadoAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { forgeArtifact } from '../src/deploy.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { startHarness, type Harness } from './harness.js';

const log = (m: string) => console.log(`[e2e-exec-fail] ${m}`);

/** `RevertsAfterArming`: `receiveFunds()` passes until `arm()` is called. */
const REVERTS_AFTER_ARMING_ABI = [
  { type: 'function', name: 'arm', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'receiveFunds', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

describe('a UserOperation whose execution reverts', () => {
  let h: Harness;
  let prover: TornadoProver;
  let reverter: Address;
  let armWallet: ReturnType<typeof createWalletClient>;

  beforeAll(async () => {
    h = await startHarness({ chainKey: 'mainnet', registry: 'worker', erc20: false, log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
    const deployer = await h.newFundedAccount(parseEther('10'));
    armWallet = createWalletClient({ account: deployer, chain: h.setup.chain, transport: http(h.rpcUrl) });
    const artifact = forgeArtifact('contracts', 'RevertsAfterArming.sol', 'RevertsAfterArming');
    const hash = await armWallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [],
      chain: h.setup.chain,
      account: armWallet.account!,
    });
    reverter = (await h.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    log(`tail call target that reverts once armed: ${reverter}`);
  }, 900_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('rolls back the withdrawal, the burn and the fee, but not the gas, the nonce or the delegation', async () => {
    const { publicClient, setup } = h;
    const reg = h.registry!;

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
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    const { leaves } = await syncLeaves(publicClient, h.instance, {
      fromBlock: h.instanceDeployBlock,
      toBlock: depositReceipt.blockNumber,
      log,
    });

    const owner = privateKeyToAccount(generatePrivateKey());
    const masterEthBefore = await publicClient.getBalance({ address: reg.master });
    const masterStakeBefore = await publicClient.readContract({
      address: reg.relayerRegistry,
      abi: relayerRegistryAbi,
      functionName: 'getRelayerBalance',
      args: [reg.master],
    });
    const depositBefore = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });

    // The withdrawal is fine; the tail call reverts.
    const result = await sponsoredWithdraw({
      publicClient,
      chain: setup.chain,
      bundlerUrl: h.bundlerUrl,
      relayerUrl: h.relayerUrl,
      instance: h.instance,
      note,
      leaves,
      prover,
      owner,
      refundTo: owner.address,
      tailCallsGas: 120_000n,
      tailCalls: ({ amount }) => [
        { to: reverter, value: amount, data: encodeFunctionData({ abi: REVERTS_AFTER_ARMING_ABI, functionName: 'receiveFunds' }) },
      ],
      skipEstimation: true,
      // After the relayer signed and before the bundler sees the operation: exactly the window a
      // pre-signing simulation cannot cover.
      afterSponsorship: async () => {
        const hash = await armWallet.writeContract({
          address: reverter,
          abi: REVERTS_AFTER_ARMING_ABI,
          functionName: 'arm',
          args: [],
          chain: setup.chain,
          account: armWallet.account!,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        log('tail call target armed after the sponsorship was signed');
      },
      log,
    });

    // Included, and reported as a failed execution.
    expect(result.receipt.success).toBe(false);
    const tx = await publicClient.getTransactionReceipt({ hash: result.receipt.receipt.transactionHash });
    expect(tx.status).toBe('success'); // the bundle transaction itself succeeded

    // Everything inside the execution frame rolled back together.
    expect(
      await publicClient.readContract({ address: h.instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] }),
    ).toBe(false);
    expect(await publicClient.getBalance({ address: reg.master })).toBe(masterEthBefore);
    expect(
      await publicClient.readContract({ address: reg.relayerRegistry, abi: relayerRegistryAbi, functionName: 'getRelayerBalance', args: [reg.master] }),
    ).toBe(masterStakeBefore);
    const burned = tx.logs
      .filter((l) => l.address.toLowerCase() === reg.relayerRegistry.toLowerCase())
      .flatMap((l) => {
        try {
          return [decodeEventLog({ abi: relayerRegistryAbi, data: l.data, topics: l.topics })];
        } catch {
          return [];
        }
      })
      .find((e) => e.eventName === 'StakeBurned');
    expect(burned, 'no TORN is burned when the withdrawal reverts').toBeUndefined();

    // The gas did not roll back: this is the paymaster's loss on a failed execution.
    const depositAfter = await publicClient.readContract({ address: h.paymaster, abi: paymasterAdminAbi, functionName: 'getDeposit' });
    const gasPaid = depositBefore - depositAfter;
    expect(gasPaid).toBeGreaterThan(0n);
    log(`failed execution cost the paymaster ${gasPaid} wei of gas, with no fee and no burn`);

    // Neither did the sender's EntryPoint nonce or its delegation. Read at the block that included the
    // operation: the node's default "latest" can still lag the receipt on a fresh fork.
    expect(result.sender.toLowerCase()).toBe(owner.address.toLowerCase());
    // The nonce key is the bundler's choice (alto picks a random 192-bit key), so read the sequence
    // under the key the operation actually used rather than assuming key 0.
    const usedNonce = BigInt(result.receipt.nonce);
    const nonceKey = usedNonce >> 64n;
    const usedSeq = usedNonce & ((1n << 64n) - 1n);
    const sequenceNow = await publicClient.readContract({
      address: setup.entryPoint,
      abi: [
        { type: 'function', name: 'getNonce', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint192' }], outputs: [{ type: 'uint256' }] },
      ] as const,
      functionName: 'getNonce',
      args: [result.sender, nonceKey],
    });
    log(`sender ${result.sender}: nonce key ${nonceKey}, used seq ${usedSeq}, sequence now ${sequenceNow & ((1n << 64n) - 1n)}`);
    expect(
      (sequenceNow & ((1n << 64n) - 1n)) > usedSeq,
      'the EntryPoint nonce is consumed even by a failed execution',
    ).toBe(true);
    expect(((await publicClient.getCode({ address: result.sender, blockNumber: tx.blockNumber })) ?? '0x').toLowerCase()).toBe(
      delegationCode(setup.simple7702Implementation).toLowerCase(),
    );

    // The note is unspent, but the relayer still holds the sponsorship it signed for it: until that
    // signature expires it could in principle still be included, and a second signature for the same
    // note would be a second operation the paymaster might have to pay for. So an immediate retry is
    // refused, by design, and the caller waits out the (short) signature lifetime.
    await expect(
      sponsoredWithdraw({
        publicClient,
        chain: setup.chain,
        bundlerUrl: h.bundlerUrl,
        relayerUrl: h.relayerUrl,
        instance: h.instance,
        note,
        leaves,
        prover,
        owner,
        refundTo: owner.address,
        tailCallsGas: 60_000n,
        tailCalls: ({ amount }) => [{ to: owner.address, value: amount, data: '0x' as Hex }],
        skipEstimation: true,
        log,
      }),
    ).rejects.toThrow(/note already sponsored/);

    // Once it has expired the same note can be retried from the same deterministic sender. Both the
    // EntryPoint nonce and the delegation are read from the chain, so the retry works even though the
    // failed attempt moved one and left the other in place. (Sponsorship lifetimes are wall-clock, so
    // the test prunes at a future timestamp instead of waiting out the TTL.)
    h.relayer.sponsorships.prune(Math.floor(Date.now() / 1000) + h.relayer.config.signatureTtlSec + 1);
    expect(h.relayer.sponsorships.get(nullifierHashHex(note))).toBeUndefined();
    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const retry = await sponsoredWithdraw({
      publicClient,
      chain: setup.chain,
      bundlerUrl: h.bundlerUrl,
      relayerUrl: h.relayerUrl,
      instance: h.instance,
      note,
      leaves,
      prover,
      owner, // the same deterministic sender: nonce 1, already delegated
      refundTo: finalRecipient,
      tailCallsGas: 60_000n,
      tailCalls: ({ amount }) => [{ to: finalRecipient, value: amount, data: '0x' as Hex }],
      skipEstimation: true,
      log,
    });
    expect(retry.receipt.success).toBe(true);
    expect(
      await publicClient.readContract({ address: h.instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] }),
    ).toBe(true);
    expect(await publicClient.getBalance({ address: finalRecipient })).toBe(h.denomination - retry.fee);
    expect(await publicClient.getBalance({ address: reg.master })).toBe(masterEthBefore + retry.fee);
    log(`retry from the same sender succeeded: recipient got ${h.denomination - retry.fee} wei`);
  }, 600_000);
});
