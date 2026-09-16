import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { Instance } from 'prool';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  isAddressEqual,
  keccak256,
  namehash,
  pad,
  parseEther,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  createRelayerApp,
  ensurePaymasterSetup,
  FixedPriceSource,
  OneInchPriceSource,
  RelayerService,
  type PriceSource,
} from '@tornado-4337/relayer';
import { CHAINS, type ChainSetup } from '../src/chains.js';
import { restoreForkCache } from './fork-cache.js';
import {
  deployErc20Tornado,
  deployEthTornado,
  deployMimcHasher,
  deployPaymaster,
  deployPaymaster7702Implementation,
  deployZap,
} from '../src/deploy.js';
import { erc20Abi, instanceRegistryAbi, paymasterAdminAbi, relayerRegistryAbi } from '../src/abi.js';

// Well-known anvil dev keys (accounts 0..4).
export const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
];

/** An unused TCP port assigned by the OS (random ports collide with whatever else runs on the machine). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface Harness {
  setup: ChainSetup;
  rpcUrl: string;
  bundlerUrl: string;
  relayerUrl: string;
  publicClient: PublicClient;
  /** Upstream RPC the fork was taken from, and the block it was taken at. */
  forkUrl: string;
  forkBlock: bigint;
  deployer: ReturnType<typeof privateKeyToAccount>;
  relayerSigner: ReturnType<typeof privateKeyToAccount>;
  instance: Address;
  denomination: bigint;
  instanceDeployBlock: bigint;
  /** ERC-20 pool for `setup.demoErc20` (fresh on forks, canonical in canonicalInstances mode). */
  erc20Instance: Address;
  erc20Denomination: bigint;
  paymaster: Address;
  /** 7702 mode: the shared implementation the relayer EOA delegates to. */
  paymasterImplementation?: Address;
  zap: Address;
  relayer: RelayerService;
  /** Address the proofs name as relayer: the paymaster, or the master EOA in worker mode. */
  rewardAccount: Address;
  /** Set when the harness wired the paymaster to the DAO router and registered it. */
  registry?: {
    mode: 'master' | 'worker';
    router: Address;
    relayerRegistry: Address;
    feeManager: Address;
    /** Registry master the paymaster resolves to (itself in master mode). */
    master: Address;
    ensName?: string;
    minStake: bigint;
  };
  setBalance(address: Address, wei: bigint): Promise<void>;
  /** A brand-new EOA funded with `wei` (default 10 ETH). */
  newFundedAccount(wei?: bigint): Promise<ReturnType<typeof privateKeyToAccount>>;
  /** Give `to` some of the demo ERC-20 (storage write on mainnet-style tokens, whale transfer otherwise). */
  dealErc20(to: Address, amount: bigint): Promise<void>;
  mine(blocks?: number): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Pinned fork heights. A pinned block lets anvil cache every upstream read on disk
 * (~/.foundry/cache/rpc/<chain>/<block>), so the second run of any suite — including the 1inch oracle
 * warm-up — never touches the upstream node, and keeps prices / registry state deterministic.
 * Override with E2E_FORK_BLOCK=<number> or E2E_FORK_BLOCK=latest. Bump when the DAO state moves on.
 */
export const PINNED_FORK_BLOCKS: Record<'mainnet' | 'sepolia', bigint> = {
  mainnet: 25_981_000n, // 2026-09-15
  sepolia: 11_710_500n, // after the sandbox DAO deployment and the live runs
};

export function pinnedForkBlock(chainKey: 'mainnet' | 'sepolia'): bigint | undefined {
  const env = process.env.E2E_FORK_BLOCK;
  if (env === 'latest') return undefined;
  if (env) return BigInt(env);
  return PINNED_FORK_BLOCKS[chainKey];
}

export interface HarnessOptions {
  chainKey?: 'mainnet' | 'sepolia';
  forkUrl?: string;
  /** Fork height (default: the pinned block for the chain; `E2E_FORK_BLOCK=latest` to fork the head). */
  forkBlockNumber?: bigint;
  /** Serve the chain's canonical Tornado pools instead of deploying a fresh instance. */
  canonicalInstances?: boolean;
  /** Which canonical ETH pool `instance` points at (default '0.1'). */
  canonicalDenomination?: string;
  /**
   * Also set up the ERC-20 demo pool and token pricing (default true). Suites that only use ETH pools
   * pass false: on mainnet forks the 1inch oracle warm-up alone costs ~2-3 minutes of RPC round-trips.
   */
  erc20?: boolean;
  denomination?: bigint;
  serviceFeeBps?: bigint;
  gasMarginBps?: bigint;
  /**
   * Mainnet forks only: point the paymaster at the DAO's TornadoRouter, add the fresh instances to
   * the InstanceRegistry (impersonated governance) and register the paymaster in the RelayerRegistry:
   *   master — a new relayer: ENS name + TORN stake given to the paymaster with anvil cheats;
   *   worker — an existing, really registered relayer (`workerOf`) adds the paymaster as its worker.
   */
  registry?: 'master' | 'worker';
  /** Worker mode: master EOA of the existing relayer (default: solid-relayer.eth's, registered 2026). */
  workerOf?: Address;
  /**
   * standalone (default): deploy a TornadoRelayerPaymaster contract.
   * 7702: the relayer signer EOA *is* the paymaster — it is registered as the worker, delegated to a freshly
   * deployed TornadoRelayerPaymaster7702 implementation, staked and funded by the relayer's own setup step.
   * Implies `registry: 'worker'`.
   */
  paymasterMode?: 'standalone' | '7702';
  /** Protocol fee (burn) set on the fresh instances, in 1e-4 (default 30 = 0.30 %, the DAO's ETH-1 setting). */
  protocolFeePercentage?: number;
  anvilPort?: number;
  altoPort?: number;
  relayerPort?: number;
  log?: (msg: string) => void;
}

/** A real mainnet relayer master (solid-relayer.eth, ~6.9k TORN staked at the time of writing). */
export const DEFAULT_WORKER_OF: Address = '0xb69e1e65142d293035323470d2B3c0c5d4E03F8e';

/**
 * Local full stack: anvil fork of a real chain (real EntryPoint v0.8, Simple7702Account,
 * Uniswap, Aave), a fresh Tornado ETH instance bound to the real Groth16 verifier, the
 * paymaster + zap from this repo, an alto bundler (Pimlico's bundler software), and the
 * relayer served in-process.
 */
export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const log = opts.log ?? ((m: string) => console.log(`[harness] ${m}`));
  const setup = CHAINS[opts.chainKey ?? 'mainnet'];
  const forkUrl =
    opts.forkUrl ??
    (setup.chain.id === 1 ? process.env.MAINNET_RPC_URL : process.env.SEPOLIA_RPC_URL) ??
    setup.publicRpc;

  // --- anvil ---------------------------------------------------------------
  const anvilPort = opts.anvilPort ?? (await freePort());
  const forkBlockNumber = opts.forkBlockNumber ?? pinnedForkBlock(opts.chainKey ?? 'mainnet');
  if (forkBlockNumber) await restoreForkCache(setup.chain.id, forkBlockNumber, log);
  const anvilInstance = Instance.anvil({
    forkUrl,
    forkBlockNumber,
    port: anvilPort,
    hardfork: 'Prague',
    chainId: setup.chain.id,
    blockTime: 1,
  });
  await anvilInstance.start();
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  log(`anvil forked ${forkUrl}${forkBlockNumber ? ` @ ${forkBlockNumber} (cached)` : ' @ latest'} on ${rpcUrl}`);

  const chain = setup.chain;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const forkBlock = await publicClient.getBlockNumber();
  const testClient = createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) });
  const setBalance = (address: Address, wei: bigint) => testClient.setBalance({ address, value: wei });
  const mine = (blocks = 1) => testClient.mine({ blocks });

  // Fresh keys, not the well-known anvil ones: on public testnets those EOAs are frequently
  // EIP-7702-delegated by tutorials, which breaks the bundler's beneficiary accounting.
  const deployerKey = generatePrivateKey();
  const relayerKey = generatePrivateKey();
  const executorKey = generatePrivateKey();
  const utilityKey = generatePrivateKey();
  const deployer = privateKeyToAccount(deployerKey);
  const relayerSigner = privateKeyToAccount(relayerKey);
  const executor = privateKeyToAccount(executorKey);
  const utility = privateKeyToAccount(utilityKey);
  for (const a of [deployer, relayerSigner, executor, utility]) await setBalance(a.address, parseEther('1000'));
  const newFundedAccount = async (wei = parseEther('10')) => {
    const account = privateKeyToAccount(generatePrivateKey());
    await setBalance(account.address, wei);
    return account;
  };

  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });

  // --- contracts ------------------------------------------------------------
  let instance: Address;
  let denomination: bigint;
  let erc20Instance: Address;
  const erc20Denomination = setup.demoErc20.denomination;
  let instanceDeployBlock = 0n;
  let hasher: Address | undefined;
  if (opts.canonicalInstances) {
    // Use the chain's real Tornado pools (needed when a wallet SDK discovers pools from the registry).
    const key = opts.canonicalDenomination ?? '0.1';
    instance = setup.tornadoEth[key]!;
    denomination = parseEther(key);
    erc20Instance = setup.tornadoErc20['dai-100']!;
  } else {
    hasher = setup.tornadoHasher ?? (await deployMimcHasher(wallet, publicClient));
    denomination = opts.denomination ?? parseEther('0.1');
    instance = await deployEthTornado(wallet, publicClient, {
      verifier: setup.tornadoVerifier,
      hasher,
      denomination,
    });
    erc20Instance = await deployErc20Tornado(wallet, publicClient, {
      verifier: setup.tornadoVerifier,
      hasher,
      denomination: erc20Denomination,
      token: setup.demoErc20.address,
    });
    instanceDeployBlock = await publicClient.getBlockNumber();
  }

  const dealErc20 = async (to: Address, amount: bigint) => {
    const { address: token, balanceSlot, whale } = setup.demoErc20;
    if (balanceSlot !== undefined) {
      const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, BigInt(balanceSlot)]));
      await testClient.setStorageAt({ address: token, index: slot, value: pad(toHex(amount), { size: 32 }) });
    } else if (whale) {
      await testClient.impersonateAccount({ address: whale });
      await setBalance(whale, parseEther('1'));
      const whaleWallet = createWalletClient({ account: whale, chain, transport: http(rpcUrl) });
      const hash = await whaleWallet.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
      await publicClient.waitForTransactionReceipt({ hash });
      await testClient.stopImpersonatingAccount({ address: whale });
    } else {
      throw new Error('no way to deal the demo ERC-20 on this chain');
    }
    const balance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [to] });
    if (balance < amount) throw new Error(`dealErc20 failed: balance ${balance} < ${amount}`);
  };
  const paymasterMode = opts.paymasterMode ?? 'standalone';
  if (paymasterMode === '7702' && opts.registry !== 'worker') throw new Error('7702 mode is the worker of an existing relayer: use registry: "worker"');
  const router = opts.registry ? setup.dao.tornadoRouter : undefined;
  if (opts.registry && !router) throw new Error(`registry mode needs a TornadoRouter; ${setup.chain.name} has none`);
  let paymaster: Address;
  let paymasterImplementation: Address | undefined;
  const setupLog = { info: (m: string, meta?: Record<string, unknown>) => log(`setup: ${m} ${meta ? JSON.stringify(meta) : ''}`), warn: (m: string) => log(`setup WARN: ${m}`) };
  if (paymasterMode === '7702') {
    paymasterImplementation = await deployPaymaster7702Implementation(wallet, publicClient, {
      entryPoint: setup.entryPoint,
      router: router!,
      gasMarginBps: opts.gasMarginBps ?? 1_000n,
      postOpGasOverhead: 45_000n,
    });
    paymaster = relayerSigner.address; // delegated below, after it is registered as a worker
  } else if (opts.registry === 'worker') {
    // The production path: the relayer software deploys its own worker contract from its key,
    // stakes and funds it; the master registers it afterwards (impersonated below).
    paymaster = await ensurePaymasterSetup(
      {
        chainId: BigInt(chain.id),
        rpcUrl,
        entryPoint: setup.entryPoint,
        signerKey: relayerKey,
        mode: 'standalone',
        autoSetup: true,
        stakeWei: parseEther('0.1'),
        unstakeDelaySec: 86_400,
        depositWei: parseEther('2'),
        router,
        gasMarginBps: opts.gasMarginBps ?? 1_000n,
        postOpGasOverhead: 45_000n,
        requireRegistration: false,
      },
      setupLog,
    );
  } else {
    paymaster = await deployPaymaster(wallet, publicClient, {
      entryPoint: setup.entryPoint,
      verifyingSigner: relayerSigner.address,
      gasMarginBps: opts.gasMarginBps ?? 1_000n,
      postOpGasOverhead: 45_000n,
      router,
    });
  }

  // --- DAO router / registry wiring -------------------------------------------
  let rewardAccount: Address = paymaster;
  let registry: Harness['registry'];
  if (opts.registry && router) {
    const { dao } = setup;
    const impersonated = async (who: Address, fn: (w: ReturnType<typeof createWalletClient>) => Promise<Hex>) => {
      await testClient.impersonateAccount({ address: who });
      await setBalance(who, parseEther('10'));
      const hash = await fn(createWalletClient({ account: who, chain, transport: http(rpcUrl) }));
      await publicClient.waitForTransactionReceipt({ hash });
      await testClient.stopImpersonatingAccount({ address: who });
    };
    // The router only serves instances the InstanceRegistry knows: add the fresh ones as governance.
    if (!opts.canonicalInstances) {
      const protocolFeePercentage = opts.protocolFeePercentage ?? 30;
      for (const [addr, isERC20, token, swapFee] of [
        [instance, false, zeroAddress, 0],
        [erc20Instance, true, setup.demoErc20.address, 3000],
      ] as const) {
        await impersonated(dao.governance, (w) =>
          w.writeContract({
            address: dao.instanceRegistry,
            abi: instanceRegistryAbi,
            functionName: 'updateInstance',
            args: [{ addr, instance: { isERC20, token, state: 1, uniswapPoolSwappingFee: swapFee, protocolFeePercentage } }],
            chain,
            account: w.account!,
          }),
        );
      }
      log(`InstanceRegistry: added fresh instances with protocolFeePercentage=${protocolFeePercentage} (governance impersonated)`);
    }
    const [minStake, feeManager] = await Promise.all([
      publicClient.readContract({ address: dao.relayerRegistry, abi: relayerRegistryAbi, functionName: 'minStakeAmount' }),
      publicClient.readContract({ address: dao.relayerRegistry, abi: relayerRegistryAbi, functionName: 'feeManager' }),
    ]);
    if (opts.registry === 'master') {
      // A fresh relayer: give the paymaster an ENS name (ENS registry storage) and the minimum TORN stake.
      const ensName = 'thin-relayer-e2e.eth';
      const node = namehash(ensName);
      await testClient.setStorageAt({
        address: dao.ensRegistry,
        index: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [node, 0n])),
        value: pad(paymaster, { size: 32 }),
      });
      await testClient.setStorageAt({
        address: dao.torn,
        index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [paymaster, 0n])),
        value: pad(toHex(minStake), { size: 32 }),
      });
      const hash = await wallet.writeContract({
        address: paymaster,
        abi: paymasterAdminAbi,
        functionName: 'registerAsRelayer',
        args: [dao.relayerRegistry, ensName, minStake],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      registry = { mode: 'master', router, relayerRegistry: dao.relayerRegistry, feeManager, master: paymaster, ensName, minStake };
      log(`RelayerRegistry: paymaster registered as master "${ensName}" with ${minStake} TORN`);
    } else {
      // An existing relayer adds the paymaster as one of its workers. On mainnet that is a real
      // registered relayer; elsewhere (the Sepolia sandbox) one is synthesized first.
      let master = opts.workerOf ?? (chain.id === 1 ? DEFAULT_WORKER_OF : undefined);
      if (!master) {
        const existing = privateKeyToAccount(generatePrivateKey()).address;
        const node = namehash('existing-relayer.eth');
        await testClient.setStorageAt({
          address: dao.ensRegistry,
          index: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [node, 0n])),
          value: pad(existing, { size: 32 }),
        });
        await testClient.setStorageAt({
          address: dao.torn,
          index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [existing, 0n])),
          value: pad(toHex(minStake), { size: 32 }),
        });
        await impersonated(existing, (w) =>
          w.writeContract({ address: dao.torn, abi: erc20Abi, functionName: 'approve', args: [dao.relayerRegistry, minStake], chain, account: w.account! }),
        );
        await impersonated(existing, (w) =>
          w.writeContract({
            address: dao.relayerRegistry,
            abi: relayerRegistryAbi,
            functionName: 'register',
            args: ['existing-relayer.eth', minStake, []],
            chain,
            account: w.account!,
          }),
        );
        master = existing;
        log(`RelayerRegistry: synthesized an existing relayer master ${master} ("existing-relayer.eth")`);
      }
      const resolved = await publicClient.readContract({
        address: dao.relayerRegistry,
        abi: relayerRegistryAbi,
        functionName: 'workers',
        args: [master],
      });
      if (!isAddressEqual(resolved, master)) throw new Error(`${master} is not a registered relayer master`);
      await impersonated(master, (w) =>
        w.writeContract({
          address: dao.relayerRegistry,
          abi: relayerRegistryAbi,
          functionName: 'registerWorker',
          args: [master, paymaster],
          chain,
          account: w.account!,
        }),
      );
      rewardAccount = master;
      registry = { mode: 'worker', router, relayerRegistry: dao.relayerRegistry, feeManager, master, minStake };
      log(`RelayerRegistry: paymaster registered as a worker of ${master} (impersonated)`);
    }
  }
  const zap = await deployZap(wallet, publicClient, {
    weth: setup.aaveWeth ?? setup.weth,
    swapRouter: setup.uniswapSwapRouter02,
    aavePool: setup.aavePool,
  });
  if (paymasterMode === '7702') {
    // Exactly what the relayer software does on first start: delegate, stake, deposit — from its own key.
    await ensurePaymasterSetup(
      {
        chainId: BigInt(chain.id),
        rpcUrl,
        entryPoint: setup.entryPoint,
        signerKey: relayerKey,
        mode: '7702',
        implementation: paymasterImplementation,
        autoSetup: true,
        stakeWei: parseEther('0.1'),
        unstakeDelaySec: 86_400,
        depositWei: parseEther('2'),
        requireRegistration: false,
      },
      setupLog,
    );
  } else if (opts.registry === 'worker') {
    // already staked and funded by the setup step above
  } else {
    const depositHash = await wallet.writeContract({
      address: paymaster,
      abi: paymasterAdminAbi,
      functionName: 'deposit',
      value: parseEther('2'),
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });
  }
  log(`deployed tornado=${instance} tornado-${setup.demoErc20.symbol}=${erc20Instance} paymaster=${paymaster}${paymasterImplementation ? ` (7702 -> ${paymasterImplementation})` : ''} zap=${zap} hasher=${hasher}`);

  // --- bundler ----------------------------------------------------------------
  const altoPort = opts.altoPort ?? (await freePort());
  const altoInstance = Instance.alto({
    rpcUrl,
    entrypoints: [setup.entryPoint],
    executorPrivateKeys: [executorKey],
    utilityPrivateKey: utilityKey,
    // ERC-7562 rule checking is done against the reference bundler's own engine
    // (client/scripts/erc7562-check.ts), not by alto here.
    safeMode: false,
    port: altoPort,
  });
  if (process.env.ALTO_LOG_FILE) {
    // Raw bundler log for debugging (every message alto prints).
    const { appendFileSync } = await import('node:fs');
    altoInstance.on('message', (m: string) => appendFileSync(process.env.ALTO_LOG_FILE!, m + '\n'));
  }
  await altoInstance.start();
  const bundlerUrl = `http://127.0.0.1:${altoPort}`;
  log(`alto bundler on ${bundlerUrl}`);

  // --- relayer (in-process) ---------------------------------------------------
  // Mainnet forks price tokens with the real 1inch oracle (as tornado-relayer does);
  // Sepolia has no oracle, so the demo token gets a fixed 3000/ETH rate.
  // The oracle aggregates dozens of DEX pools, so its first call on a fork pulls a lot of state
  // through the upstream RPC: give it a long timeout (the result is cached afterwards).
  const erc20 = opts.erc20 ?? true;
  const priceSource: PriceSource =
    chain.id === 1 && erc20
      ? new OneInchPriceSource(createPublicClient({ chain, transport: http(rpcUrl, { timeout: 600_000 }) }))
      : new FixedPriceSource({ [setup.demoErc20.address]: '3000' });
  if (chain.id === 1 && erc20) {
    const t0 = Date.now();
    const rate = await priceSource.tokenPerEth(setup.demoErc20.address, setup.demoErc20.decimals);
    log(`1inch oracle: ${rate} ${setup.demoErc20.symbol}-units per ETH (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const relayer = await RelayerService.create(
    {
      chainId: BigInt(chain.id),
      rpcUrl,
      bundlerUrl,
      entryPoint: setup.entryPoint,
      paymaster,
      signerKey: relayerKey,
      rewardAccount,
      instances: opts.canonicalInstances
        ? [...Object.values(setup.tornadoEth), ...(erc20 ? [erc20Instance] : [])]
        : [instance, ...(erc20 ? [erc20Instance] : [])],
      priceSource,
      serviceFeeBps: opts.serviceFeeBps ?? 30n,
      signatureTtlSec: 300,
      simulateWithBundler: true,
      gasPriceMarginBps: 11_000n,
      sponsorName: 'tornado-4337-relayer (e2e)',
    },
    { info: (m, meta) => log(`relayer: ${m} ${meta ? JSON.stringify(meta) : ''}`), warn: (m) => log(`relayer WARN: ${m}`) },
  );
  const relayerPort = opts.relayerPort ?? (await freePort());
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: createRelayerApp(relayer).fetch, port: relayerPort }, () => resolve(s));
  });
  const relayerUrl = `http://127.0.0.1:${relayerPort}`;
  log(`relayer on ${relayerUrl}`);

  return {
    setup,
    rpcUrl,
    bundlerUrl,
    relayerUrl,
    publicClient,
    forkUrl,
    forkBlock,
    deployer,
    relayerSigner,
    instance,
    denomination,
    instanceDeployBlock,
    erc20Instance,
    erc20Denomination,
    paymaster,
    paymasterImplementation,
    zap,
    relayer,
    rewardAccount,
    registry,
    setBalance,
    newFundedAccount,
    dealErc20,
    mine,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      await altoInstance.stop();
      await anvilInstance.stop();
    },
  };
}
