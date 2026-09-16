/**
 * A throwaway geth `--dev` chain with the canonical ERC-4337 v0.8 contracts and the sandbox DAO, for
 * the strict-bundler acceptance run. geth is the one node both strict validators are written against:
 * its native `erc7562Tracer` (geth >= 1.15) drives the eth-infinitism reference bundler's safe mode, and
 * its JS tracer semantics are what alto's safe-mode collector tracer expects (anvil differs in both).
 *
 * The chain runs a Prague genesis (mainnet today); everything on it is a real transaction — no cheatcodes:
 *   1. the deterministic deployment proxy (Nick's presigned tx), then EntryPoint v0.8 and
 *      Simple7702Account replayed from their mainnet deployment calldata (same salt + initCode = same
 *      addresses 0x4337… / 0xe6Ca…; the EntryPoint constructor recreates SenderCreator at 0x449E…);
 *   2. Tornado's Groth16 verifier (mainnet runtime redeployed), a MiMC hasher, a fresh ETH-0.1 pool;
 *   3. the sandbox DAO (contracts/src/dao-sandbox, mainnet RelayerRegistry logic), the pool enabled with
 *      the DAO's protocol fee;
 *   4. an "existing relayer" master (ENS name + TORN stake, `register`), the relayer software's own
 *      worker-contract setup from its key (deploy, stake 1 ETH, deposit), `registerWorker` by the master;
 *   5. the bundler under test (safe mode) and the relayer JSON-RPC.
 *
 * Fixture: e2e/fork-cache/canonical-4337.json (scripts/fetch-canonical-4337.ts).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { Instance } from 'prool';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  getContractAddress,
  http,
  namehash,
  parseEther,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  zeroAddress,
} from 'viem';
import { english, generateMnemonic, generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { createRelayerApp, ensurePaymasterSetup, RelayerService } from '@tornado-4337/relayer';
import { resolveBundlerDir, startReferenceBundler } from '../src/aa-bundler.js';
import { erc20Abi, relayerRegistryAbi } from '../src/abi.js';
import { deployEthTornado, deployMimcHasher, forgeArtifact } from '../src/deploy.js';
import { freePort } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface Canonical4337Fixture {
  deterministicDeployer: Address;
  deterministicDeployerTx: { from: Address; raw: Hex; txHash: Hex };
  entryPoint: { address: Address; salt: Hex; initCode: Hex; data: Hex; gas: string };
  simple7702Account: { address: Address; salt: Hex; initCode: Hex; data: Hex; gas: string };
  tornadoVerifier: { mainnetAddress: Address; runtime: Hex };
}

export function loadCanonical4337(): Canonical4337Fixture {
  return JSON.parse(readFileSync(join(here, 'fork-cache', 'canonical-4337.json'), 'utf8')) as Canonical4337Fixture;
}

/** `geth` on PATH (Homebrew `ethereum`), and new enough to ship the native erc7562Tracer (>= 1.15). */
export function gethAvailable(): boolean {
  try {
    const v = execFileSync('geth', ['version'], { encoding: 'utf8' });
    const m = v.match(/Version: (\d+)\.(\d+)\./);
    return !!m && (Number(m[1]) > 1 || Number(m[2]) >= 15);
  } catch {
    return false;
  }
}

const ENS_ABI = [
  { type: 'function', name: 'setOwner', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [] },
] as const;
const DAO_NAMES = ['SandboxTORN', 'SandboxENS', 'SandboxStakingRewards', 'SandboxInstanceRegistry', 'SandboxFeeManager', 'SandboxRelayerRegistry', 'SandboxTornadoRouter'] as const;

export interface GethDevHarness {
  chain: Chain;
  setup: { chain: Chain; entryPoint: Address; simple7702Implementation: Address };
  rpcUrl: string;
  bundler: 'alto-safe' | 'reference';
  bundlerUrl: string;
  bundlerOutput(): string;
  relayerUrl: string;
  publicClient: PublicClient;
  canonical: Canonical4337Fixture;
  instance: Address;
  denomination: bigint;
  instanceDeployBlock: bigint;
  paymaster: Address;
  registry: { master: Address; masterEnsName: string; relayerRegistry: Address; router: Address; minStake: bigint };
  dao: Record<(typeof DAO_NAMES)[number], Address>;
  newFundedAccount(wei?: bigint): Promise<ReturnType<typeof privateKeyToAccount>>;
  stop(): Promise<void>;
}

export interface GethDevOptions {
  bundler: 'alto-safe' | 'reference';
  log?: (msg: string) => void;
}

export async function startGethDevHarness(opts: GethDevOptions): Promise<GethDevHarness> {
  const log = opts.log ?? ((m: string) => console.log(`[geth-dev] ${m}`));
  if (!gethAvailable()) throw new Error('geth >= 1.15 is required on PATH (brew install ethereum)');
  const canonical = loadCanonical4337();

  // --- geth --dev with a Prague genesis --------------------------------------------
  // geth's built-in dev genesis enables every fork it knows, including experimental future repricings
  // (the nonce SSTORE alone cost ~108k gas there); mainnet-today (Prague) is what we sign gas for.
  const port = await freePort();
  const datadir = mkdtempSync(join(tmpdir(), 'geth-dev-'));
  const passwordFile = join(datadir, 'password');
  writeFileSync(passwordFile, 'dev', { mode: 0o600 });
  const newAccount = execFileSync('geth', ['account', 'new', '--datadir', datadir, '--password', passwordFile], { encoding: 'utf8' });
  const dev = newAccount.match(/0x[0-9a-fA-F]{40}/)?.[0] as Address | undefined;
  if (!dev) throw new Error(`could not create the developer account:\n${newAccount}`);
  const genesis = {
    config: {
      chainId: 1337,
      homesteadBlock: 0, eip150Block: 0, eip155Block: 0, eip158Block: 0, byzantiumBlock: 0, constantinopleBlock: 0, petersburgBlock: 0,
      istanbulBlock: 0, muirGlacierBlock: 0, berlinBlock: 0, londonBlock: 0, arrowGlacierBlock: 0, grayGlacierBlock: 0, mergeNetsplitBlock: 0,
      shanghaiTime: 0, cancunTime: 0, pragueTime: 0,
      terminalTotalDifficulty: 0, terminalTotalDifficultyPassed: true,
      blobSchedule: { cancun: { target: 3, max: 6, baseFeeUpdateFraction: 3338477 }, prague: { target: 6, max: 9, baseFeeUpdateFraction: 5007716 } },
      depositContractAddress: '0x00000000219ab540356cbb839cbe05303d7705fa',
    },
    nonce: '0x0', timestamp: '0x0', extraData: '0x', gasLimit: '0x1c9c380', difficulty: '0x0',
    mixHash: `0x${'00'.repeat(32)}`, coinbase: `0x${'00'.repeat(20)}`,
    alloc: { [dev]: { balance: toHex(10n ** 30n) } },
    number: '0x0', gasUsed: '0x0', parentHash: `0x${'00'.repeat(32)}`,
  };
  const genesisFile = join(datadir, 'genesis.json');
  writeFileSync(genesisFile, JSON.stringify(genesis));
  execFileSync('geth', ['init', '--datadir', datadir, genesisFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const geth: ChildProcess = spawn(
    'geth',
    [
      '--dev', '--dev.period', '1', '--datadir', datadir, '--password', passwordFile, '--ipcdisable',
      '--http', '--http.port', String(port), '--http.api', 'eth,net,web3,debug', '--http.vhosts', '*',
      '--rpc.allow-unprotected-txs', '--nodiscover', '--maxpeers', '0', '--verbosity', '1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let gethOutput = '';
  geth.stdout!.on('data', (d) => (gethOutput += d));
  geth.stderr!.on('data', (d) => (gethOutput += d));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: 1337,
    name: 'geth-dev',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method, params } as never) as Promise<unknown>;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (geth.exitCode !== null) throw new Error(`geth exited early:\n${gethOutput}`);
    try {
      await rpc('eth_chainId');
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`geth did not come up:\n${gethOutput}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const stopGeth = async () => {
    if (geth.exitCode === null) {
      geth.kill('SIGTERM');
      await Promise.race([new Promise((r) => geth.once('exit', r)), new Promise((r) => setTimeout(r, 5_000))]);
      if (geth.exitCode === null) geth.kill('SIGKILL');
    }
    rmSync(datadir, { recursive: true, force: true });
  };
  log(`geth --dev on ${rpcUrl} (${(await rpc('web3_clientVersion')) as string})`);

  try {
    // --- the developer account funds everything -----------------------------------
    const fund = async (to: Address, wei: bigint) => {
      const hash = (await rpc('eth_sendTransaction', [{ from: dev, to, value: toHex(wei) }])) as Hex;
      await publicClient.waitForTransactionReceipt({ hash });
    };
    const newFundedAccount = async (wei = parseEther('10')) => {
      const account = privateKeyToAccount(generatePrivateKey());
      await fund(account.address, wei);
      return account;
    };
    const deployerKey = generatePrivateKey();
    const relayerKey = generatePrivateKey();
    const masterKey = generatePrivateKey();
    const executorKey = generatePrivateKey();
    const utilityKey = generatePrivateKey();
    const [deployer, relayerSigner, master, executor, utility] = [deployerKey, relayerKey, masterKey, executorKey, utilityKey].map((k) => privateKeyToAccount(k));
    for (const a of [deployer, relayerSigner, master, executor, utility]) await fund(a.address, parseEther('1000'));
    const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
    const masterWallet = createWalletClient({ account: master, chain, transport: http(rpcUrl) });
    const wait = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });

    // --- canonical 4337 contracts at their canonical addresses ----------------------
    await fund(canonical.deterministicDeployerTx.from, parseEther('0.1'));
    await wait((await rpc('eth_sendRawTransaction', [canonical.deterministicDeployerTx.raw])) as Hex);
    for (const c of [canonical.entryPoint, canonical.simple7702Account]) {
      const r = await wait((await rpc('eth_sendTransaction', [{ from: dev, to: canonical.deterministicDeployer, data: c.data, gas: toHex(BigInt(c.gas) + 200_000n) }])) as Hex);
      const code = await publicClient.getCode({ address: c.address });
      if (r.status !== 'success' || !code || code === '0x') throw new Error(`canonical deployment at ${c.address} failed`);
    }
    const entryPoint = canonical.entryPoint.address;
    const simple7702Implementation = canonical.simple7702Account.address;
    log(`EntryPoint v0.8 at ${entryPoint}, Simple7702Account at ${simple7702Implementation} (mainnet calldata replayed through ${canonical.deterministicDeployer})`);

    // --- Tornado: verifier (mainnet runtime), hasher, ETH-0.1 pool -------------------
    const runtime = canonical.tornadoVerifier.runtime;
    const verifierReceipt = await wait(await wallet.sendTransaction({ data: concatHex(['0x600b380380600b3d393df3', runtime]) }));
    const verifier = verifierReceipt.contractAddress!;
    const hasher = await deployMimcHasher(wallet, publicClient);
    const denomination = parseEther('0.1');
    const instance = await deployEthTornado(wallet, publicClient, { verifier, hasher, denomination });
    const instanceDeployBlock = await publicClient.getBlockNumber();
    log(`Tornado ETH-0.1 pool ${instance} (verifier ${verifier}, hasher ${hasher})`);

    // --- sandbox DAO (contracts/src/dao-sandbox), wired exactly as script/DeploySandboxDao.s.sol does ---
    // Deployed from here with the node's own gas estimates: geth --dev runs the newest fork (Osaka),
    // whose creation costs exceed forge's Prague simulation and made `forge script --broadcast` run dry.
    const art = (name: (typeof DAO_NAMES)[number]) => forgeArtifact('contracts', `${name}.sol`, name);
    const deployDao = async (name: (typeof DAO_NAMES)[number], args: unknown[]) => {
      const { abi, bytecode } = art(name);
      const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args });
      const receipt = await wait(hash);
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed (${hash})`);
      return receipt.contractAddress;
    };
    const call = async (name: (typeof DAO_NAMES)[number], address: Address, functionName: string, args: unknown[]) => {
      const receipt = await wait(await wallet.writeContract({ address, abi: art(name).abi, functionName, args }));
      if (receipt.status !== 'success') throw new Error(`${name}.${functionName} reverted`);
    };
    const dao = {} as Record<(typeof DAO_NAMES)[number], Address>;
    const tornPerEth = 379n * 10n ** 18n; // ≈ mainnet at the time of writing (the script's default)
    const minStakeTorn = 5_000n * 10n ** 18n;
    dao.SandboxTORN = await deployDao('SandboxTORN', [deployer.address, 10_000_000n * 10n ** 18n]);
    dao.SandboxENS = await deployDao('SandboxENS', []);
    dao.SandboxStakingRewards = await deployDao('SandboxStakingRewards', [deployer.address, dao.SandboxTORN]);
    dao.SandboxInstanceRegistry = await deployDao('SandboxInstanceRegistry', [deployer.address]);
    dao.SandboxFeeManager = await deployDao('SandboxFeeManager', [dao.SandboxTORN, deployer.address, dao.SandboxInstanceRegistry, 172_800]);
    dao.SandboxRelayerRegistry = await deployDao('SandboxRelayerRegistry', [dao.SandboxTORN, deployer.address, dao.SandboxENS, dao.SandboxStakingRewards, dao.SandboxFeeManager]);
    dao.SandboxTornadoRouter = await deployDao('SandboxTornadoRouter', [deployer.address, dao.SandboxInstanceRegistry, dao.SandboxRelayerRegistry]);
    await call('SandboxInstanceRegistry', dao.SandboxInstanceRegistry, 'setTornadoRouter', [dao.SandboxTornadoRouter]);
    await call('SandboxRelayerRegistry', dao.SandboxRelayerRegistry, 'setTornadoRouter', [dao.SandboxTornadoRouter]);
    await call('SandboxStakingRewards', dao.SandboxStakingRewards, 'setRelayerRegistry', [dao.SandboxRelayerRegistry]);
    await call('SandboxRelayerRegistry', dao.SandboxRelayerRegistry, 'setMinStakeAmount', [minStakeTorn]);
    await call('SandboxFeeManager', dao.SandboxFeeManager, 'setTornPerAsset', [zeroAddress, tornPerEth]);
    await call('SandboxInstanceRegistry', dao.SandboxInstanceRegistry, 'updateInstance', [
      { addr: instance, instance: { isERC20: false, token: zeroAddress, state: 1, uniswapPoolSwappingFee: 0, protocolFeePercentage: 30 } },
    ]);
    await call('SandboxFeeManager', dao.SandboxFeeManager, 'updateAllFees', []);
    const router = dao.SandboxTornadoRouter;
    const relayerRegistry = dao.SandboxRelayerRegistry;
    log(`sandbox DAO: router ${router}, registry ${relayerRegistry}, TORN ${dao.SandboxTORN}`);

    // --- an existing relayer master, registered the way a real one is ---------------
    const minStake = await publicClient.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'minStakeAmount' });
    const masterEnsName = 'existing-relayer.sandbox.eth';
    await wait(await wallet.writeContract({ address: dao.SandboxENS, abi: ENS_ABI, functionName: 'setOwner', args: [namehash(masterEnsName), master.address] }));
    await wait(await wallet.writeContract({ address: dao.SandboxTORN, abi: erc20Abi, functionName: 'transfer', args: [master.address, minStake] }));
    await wait(await masterWallet.writeContract({ address: dao.SandboxTORN, abi: erc20Abi, functionName: 'approve', args: [relayerRegistry, minStake] }));
    await wait(await masterWallet.writeContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'register', args: [masterEnsName, minStake, []] }));
    log(`master ${master.address} registered as "${masterEnsName}" with ${minStake} TORN`);

    // --- the relayer software's own worker contract, then the master adds it --------
    const setupLog = { info: (m: string, meta?: unknown) => log(`setup: ${m} ${meta ? JSON.stringify(meta) : ''}`), warn: (m: string) => log(`setup WARN: ${m}`) };
    const paymaster = await ensurePaymasterSetup(
      {
        chainId: BigInt(chain.id),
        rpcUrl,
        entryPoint,
        signerKey: relayerKey,
        mode: 'standalone',
        autoSetup: true,
        stakeWei: parseEther('1'), // both strict bundlers' default entity minimum
        unstakeDelaySec: 86_400,
        depositWei: parseEther('2'),
        router,
        gasMarginBps: 1_000n,
        postOpGasOverhead: 45_000n,
        requireRegistration: false,
      },
      setupLog,
    );
    await wait(await masterWallet.writeContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'registerWorker', args: [master.address, paymaster] }));
    log(`worker paymaster ${paymaster} registered under the master`);

    // --- bundler under test ----------------------------------------------------------
    let bundlerUrl: string;
    let stopBundler: () => Promise<void>;
    let bundlerOutput = () => '';
    if (opts.bundler === 'reference') {
      const mnemonic = generateMnemonic(english);
      const signer = mnemonicToAccount(mnemonic);
      await fund(signer.address, parseEther('100'));
      const ref = await startReferenceBundler({
        dir: resolveBundlerDir(),
        rpcUrl,
        chainId: chain.id,
        entryPoint,
        mnemonic,
        beneficiary: signer.address,
        port: await freePort(),
        privateApiPort: await freePort(),
        tracer: 'native',
        log: process.env.BUNDLER_LOG ? log : undefined,
      });
      bundlerUrl = ref.url;
      stopBundler = ref.stop;
      bundlerOutput = ref.output;
      log(`eth-infinitism reference bundler (safe mode, native erc7562Tracer) on ${bundlerUrl}`);
    } else {
      const altoPort = await freePort();
      const alto = Instance.alto({
        rpcUrl,
        entrypoints: [entryPoint],
        executorPrivateKeys: [executorKey],
        utilityPrivateKey: utilityKey,
        safeMode: true,
        port: altoPort,
      });
      let altoLog = '';
      alto.on('message', (m: string) => (altoLog += m + '\n'));
      await alto.start();
      bundlerUrl = `http://127.0.0.1:${altoPort}`;
      stopBundler = () => alto.stop();
      bundlerOutput = () => altoLog;
      log(`alto bundler (safe mode) on ${bundlerUrl}`);
    }

    // --- relayer --------------------------------------------------------------------
    const relayer = await RelayerService.create(
      {
        chainId: BigInt(chain.id),
        rpcUrl,
        bundlerUrl,
        entryPoint,
        paymaster,
        signerKey: relayerKey,
        rewardAccount: master.address,
        instances: [instance],
        serviceFeeBps: 30n,
        signatureTtlSec: 300,
        // see harness.ts: the reference bundler's estimator cannot run validation-granted callData
        simulateWithBundler: opts.bundler !== 'reference',
        gasPriceMarginBps: 11_000n,
        sponsorName: 'tornado-4337-relayer (geth-dev e2e)',
      },
      { info: (m, meta) => log(`relayer: ${m} ${meta ? JSON.stringify(meta) : ''}`), warn: (m) => log(`relayer WARN: ${m}`) },
    );
    const relayerPort = await freePort();
    const server: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: createRelayerApp(relayer).fetch, port: relayerPort }, () => resolve(s));
    });
    const relayerUrl = `http://127.0.0.1:${relayerPort}`;
    log(`relayer on ${relayerUrl}`);

    return {
      chain,
      setup: { chain, entryPoint, simple7702Implementation },
      rpcUrl,
      bundler: opts.bundler,
      bundlerUrl,
      bundlerOutput,
      relayerUrl,
      publicClient,
      canonical,
      instance,
      denomination,
      instanceDeployBlock,
      paymaster,
      registry: { master: master.address, masterEnsName, relayerRegistry, router, minStake },
      dao,
      newFundedAccount,
      async stop() {
        await new Promise<void>((r) => server.close(() => r()));
        await stopBundler();
        if (process.env.GETH_DEV_KEEP) log(`GETH_DEV_KEEP set: leaving geth running on ${rpcUrl} (datadir ${datadir})`);
        else await stopGeth();
      },
    };
  } catch (err) {
    if (process.env.GETH_DEV_KEEP) log(`GETH_DEV_KEEP set: leaving geth running on ${rpcUrl} (datadir ${datadir})`);
    else await stopGeth();
    throw err;
  }
}
