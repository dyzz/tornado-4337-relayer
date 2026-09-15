/**
 * Mainnet acceptance run (fork of a real node, nothing governance-owned is touched):
 *   canonical Tornado ETH 100 pool  +  the DAO's live TornadoRouter / RelayerRegistry / FeeManager
 *   +  a really registered relayer master (solid-relayer.eth)  +  a worker paymaster contract the
 *   relayer software deploys, stakes and funds from its own key  +  the master registering it
 *   (the only impersonated step: that key is theirs)  +  alto bundler.
 * Expect: the withdrawal goes Router -> burn (the pool's real TORN fee from the master's stake)
 * -> pool, the fee lands on the master, swap -> Aave runs atomically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { aavePoolAbi, erc20Abi, feeManagerAbi, instanceRegistryAbi, paymasterAdminAbi, relayerRegistryAbi, tornadoAbi, zapAbi } from '../src/abi.js';
import { loadArtifacts } from '../src/artifacts.js';
import { sponsoredWithdraw } from '../src/flow.js';
import { syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex } from '../src/note.js';
import { createTornadoProver, type TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { FIXTURE_DIR } from './fork-cache.js';
import { startHarness, type Harness } from './harness.js';

const log = (m: string) => console.log(`[acceptance] ${m}`);
/** Tornado's ETH pools were deployed in Dec 2019 (block ~9.1M); the tornado-cli cache makes that irrelevant. */
const POOLS_DEPLOY_BLOCK = 9_100_000n;
/** tornado-cli checkout: its `cache/ethereum/deposits_eth_100.json` seeds the leaf sync (as the classic CLI does). */
const TORNADO_CLI_DIR = process.env.TORNADO_CLI_DIR ?? new URL('../../../tornado-cli', import.meta.url).pathname;

describe('mainnet acceptance: canonical pool, live DAO contracts, existing relayer, software-deployed worker', () => {
  let h: Harness;
  let prover: TornadoProver;

  beforeAll(async () => {
    h = await startHarness({ chainKey: 'mainnet', canonicalInstances: true, canonicalDenomination: '100', registry: 'worker', erc20: false, log });
    const { circuit, provingKey } = await loadArtifacts();
    prover = await createTornadoProver(circuit, provingKey);
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('withdraws 100 ETH through the live router, burns the real TORN fee from the master, swaps into Aave', async () => {
    const { publicClient, setup } = h;
    const reg = h.registry!;
    const dao = setup.dao;

    // Nothing governance-owned was modified: the pool is exactly as registered by the DAO.
    const entry = await publicClient.readContract({ address: dao.instanceRegistry, abi: instanceRegistryAbi, functionName: 'instances', args: [h.instance] });
    expect(entry[2]).toBe(1); // ENABLED
    expect(entry[4]).toBeGreaterThan(0); // protocolFeePercentage set by the DAO
    log(`pool ${h.instance}: state=${entry[2]} protocolFee=${entry[4]} bps/100`);

    const status = await new RelayerRpc(h.relayerUrl).status();
    expect(status.registry.mode).toBe('worker');
    expect(status.registry.master.toLowerCase()).toBe(reg.master.toLowerCase());
    expect(status.registry.router.toLowerCase()).toBe(dao.tornadoRouter!.toLowerCase());
    expect(status.registry.relayerRegistry.toLowerCase()).toBe(dao.relayerRegistry.toLowerCase());

    // Shield into the canonical pool and sync its real deposit tree.
    const depositor = await h.newFundedAccount(parseEther('101'));
    const depositorWallet = createWalletClient({ account: depositor, chain: setup.chain, transport: http(h.rpcUrl) });
    const note = createNote();
    const depositTx = await depositorWallet.writeContract({ address: h.instance, abi: tornadoAbi, functionName: 'deposit', args: [commitmentHex(note)], value: h.denomination });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    // History up to the fork block is scanned straight from the upstream node (parallel 100k-block
    // requests, reth's per-request limit) starting from tornado-cli's cache; the fork itself only
    // contributes the blocks after that (our deposit). Cached locally for later runs.
    const t0 = Date.now();
    const cacheFile = new URL(`../.cache/leaves-${h.setup.chain.id}-${h.instance}.json`, import.meta.url).pathname;
    const fixture = `${FIXTURE_DIR}/leaves-${h.setup.chain.id}-${h.instance}.json.gz`;
    if (!existsSync(cacheFile) && existsSync(fixture)) {
      mkdirSync(dirname(cacheFile), { recursive: true });
      await pipeline(createReadStream(fixture), createGunzip(), createWriteStream(cacheFile));
      log(`restored leaf cache from ${fixture}`);
    }
    const upstream = createPublicClient({ chain: setup.chain, transport: http(h.forkUrl, { timeout: 180_000 }) });
    await syncLeaves(upstream, h.instance, {
      fromBlock: POOLS_DEPLOY_BLOCK,
      seedFile: `${TORNADO_CLI_DIR}/cache/ethereum/deposits_eth_100.json`,
      cacheFile,
      toBlock: h.forkBlock,
      chunk: 100_000n,
      concurrency: 8,
      log: (m) => { if (!m.startsWith('synced 0x')) log(m); },
    });
    const { leaves } = await syncLeaves(publicClient, h.instance, { fromBlock: POOLS_DEPLOY_BLOCK, cacheFile, chunk: 5_000n });
    log(`synced ${leaves.length} leaves in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    expect(leaves.length).toBeGreaterThan(1);

    const finalRecipient = privateKeyToAccount(generatePrivateKey()).address;
    const masterEthBefore = await publicClient.getBalance({ address: reg.master });
    const masterStakeBefore = await publicClient.readContract({ address: reg.relayerRegistry, abi: relayerRegistryAbi, functionName: 'getRelayerBalance', args: [reg.master] });
    const tokenOut = setup.demoTokenOut;

    const result = await sponsoredWithdraw({
      publicClient,
      chain: setup.chain,
      bundlerUrl: h.bundlerUrl,
      relayerUrl: h.relayerUrl,
      instance: h.instance,
      note,
      leaves,
      prover,
      owner: privateKeyToAccount(generatePrivateKey()),
      refundTo: finalRecipient,
      tailCallsGas: 450_000n,
      tailCalls: ({ amount }) => [{ to: h.zap, value: amount, data: encodeFunctionData({ abi: zapAbi, functionName: 'swapEthAndSupply', args: [tokenOut.address, tokenOut.uniswapFee, 0n, finalRecipient] }) }],
      log,
    });
    expect(result.receipt.success).toBe(true);
    expect(await publicClient.readContract({ address: h.instance, abi: tornadoAbi, functionName: 'isSpent', args: [nullifierHashHex(note)] })).toBe(true);
    const receipt = await publicClient.getTransactionReceipt({ hash: result.receipt.receipt.transactionHash });

    const burned = receipt.logs
      .filter((l) => l.address.toLowerCase() === reg.relayerRegistry.toLowerCase())
      .flatMap((l) => { try { return [decodeEventLog({ abi: relayerRegistryAbi, data: l.data, topics: l.topics })]; } catch { return []; } })
      .find((e) => e.eventName === 'StakeBurned');
    expect(burned, 'StakeBurned from the live registry').toBeDefined();
    const burnedAmount = (burned!.args as { amountBurned: bigint }).amountBurned;
    const instanceFee = await publicClient.readContract({ address: reg.feeManager, abi: feeManagerAbi, functionName: 'instanceFee', args: [h.instance] });
    expect(burnedAmount).toBe(BigInt(instanceFee));
    expect(burnedAmount).toBeGreaterThan(0n);
    expect(await publicClient.readContract({ address: reg.relayerRegistry, abi: relayerRegistryAbi, functionName: 'getRelayerBalance', args: [reg.master] })).toBe(masterStakeBefore - burnedAmount);
    expect(await publicClient.getBalance({ address: reg.master })).toBe(masterEthBefore + result.fee);

    const relayed = receipt.logs
      .filter((l) => l.address.toLowerCase() === h.paymaster.toLowerCase())
      .flatMap((l) => { try { return [decodeEventLog({ abi: paymasterAdminAbi, data: l.data, topics: l.topics })]; } catch { return []; } })
      .find((e) => e.eventName === 'Relayed');
    expect((relayed!.args as { viaRouter: boolean }).viaRouter).toBe(true);

    const reserve = await publicClient.readContract({ address: setup.aavePool, abi: aavePoolAbi, functionName: 'getReserveData', args: [tokenOut.address] });
    const aBal = await publicClient.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [finalRecipient] });
    log(`burned ${burnedAmount} TORN from ${reg.master}; fee ${result.fee} wei to the master; a${tokenOut.symbol} ${aBal} for the recipient`);
    expect(aBal).toBeGreaterThan(0n);
  });
});
