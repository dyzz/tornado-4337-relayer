import { serve, type ServerType } from '@hono/node-server';
import { Instance } from 'prool';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createRelayerApp, RelayerService } from '@tornado-4337/relayer';
import { CHAINS, type ChainSetup } from '../src/chains.js';
import { deployEthTornado, deployMimcHasher, deployPaymaster, deployZap } from '../src/deploy.js';
import { paymasterAdminAbi } from '../src/abi.js';

// Well-known anvil dev keys (accounts 0..4).
export const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
];

export interface Harness {
  setup: ChainSetup;
  rpcUrl: string;
  bundlerUrl: string;
  relayerUrl: string;
  publicClient: PublicClient;
  deployer: ReturnType<typeof privateKeyToAccount>;
  relayerSigner: ReturnType<typeof privateKeyToAccount>;
  instance: Address;
  denomination: bigint;
  instanceDeployBlock: bigint;
  paymaster: Address;
  zap: Address;
  relayer: RelayerService;
  setBalance(address: Address, wei: bigint): Promise<void>;
  mine(blocks?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  chainKey?: 'mainnet' | 'sepolia';
  forkUrl?: string;
  forkBlockNumber?: bigint;
  /** Serve the chain's canonical Tornado pools instead of deploying a fresh instance. */
  canonicalInstances?: boolean;
  denomination?: bigint;
  serviceFeeBps?: bigint;
  gasMarginBps?: bigint;
  anvilPort?: number;
  altoPort?: number;
  relayerPort?: number;
  log?: (msg: string) => void;
}

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
  const anvilPort = opts.anvilPort ?? 8545 + Math.floor(Math.random() * 500);
  const anvilInstance = Instance.anvil({
    forkUrl,
    forkBlockNumber: opts.forkBlockNumber,
    port: anvilPort,
    hardfork: 'Prague',
    chainId: setup.chain.id,
    blockTime: 1,
  });
  await anvilInstance.start();
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  log(`anvil forked ${forkUrl} on ${rpcUrl}`);

  const chain = setup.chain;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) });
  const setBalance = (address: Address, wei: bigint) => testClient.setBalance({ address, value: wei });
  const mine = (blocks = 1) => testClient.mine({ blocks });

  const deployer = privateKeyToAccount(ANVIL_KEYS[0]!);
  const relayerSigner = privateKeyToAccount(ANVIL_KEYS[1]!);
  const executor = privateKeyToAccount(ANVIL_KEYS[2]!);
  const utility = privateKeyToAccount(ANVIL_KEYS[3]!);
  for (const a of [deployer, relayerSigner, executor, utility]) await setBalance(a.address, parseEther('1000'));

  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });

  // --- contracts ------------------------------------------------------------
  let instance: Address;
  let denomination: bigint;
  let instanceDeployBlock = 0n;
  let hasher: Address | undefined;
  if (opts.canonicalInstances) {
    // Use the chain's real Tornado pools (needed when a wallet SDK discovers pools from the registry).
    instance = setup.tornadoEth['0.1']!;
    denomination = parseEther('0.1');
  } else {
    hasher = setup.tornadoHasher ?? (await deployMimcHasher(wallet, publicClient));
    denomination = opts.denomination ?? parseEther('0.1');
    instance = await deployEthTornado(wallet, publicClient, {
      verifier: setup.tornadoVerifier,
      hasher,
      denomination,
    });
    instanceDeployBlock = await publicClient.getBlockNumber();
  }
  const paymaster = await deployPaymaster(wallet, publicClient, {
    entryPoint: setup.entryPoint,
    verifyingSigner: relayerSigner.address,
    gasMarginBps: opts.gasMarginBps ?? 1_000n,
    postOpGasOverhead: 45_000n,
  });
  const zap = await deployZap(wallet, publicClient, {
    weth: setup.aaveWeth ?? setup.weth,
    swapRouter: setup.uniswapSwapRouter02,
    aavePool: setup.aavePool,
  });
  const depositHash = await wallet.writeContract({
    address: paymaster,
    abi: paymasterAdminAbi,
    functionName: 'deposit',
    value: parseEther('2'),
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  log(`deployed tornado=${instance} paymaster=${paymaster} zap=${zap} hasher=${hasher}`);

  // --- alto -----------------------------------------------------------------
  const altoPort = opts.altoPort ?? 4337 + Math.floor(Math.random() * 500);
  const altoInstance = Instance.alto({
    rpcUrl,
    entrypoints: [setup.entryPoint],
    executorPrivateKeys: [ANVIL_KEYS[2]!],
    utilityPrivateKey: ANVIL_KEYS[3]!,
    safeMode: false,
    port: altoPort,
  });
  await altoInstance.start();
  const bundlerUrl = `http://127.0.0.1:${altoPort}`;
  log(`alto bundler on ${bundlerUrl}`);

  // --- relayer (in-process) ---------------------------------------------------
  const relayer = await RelayerService.create(
    {
      chainId: BigInt(chain.id),
      rpcUrl,
      bundlerUrl,
      entryPoint: setup.entryPoint,
      paymaster,
      signerKey: ANVIL_KEYS[1]!,
      instances: opts.canonicalInstances ? Object.values(setup.tornadoEth) : [instance],
      serviceFeeBps: opts.serviceFeeBps ?? 30n,
      signatureTtlSec: 300,
      simulateWithBundler: true,
      gasPriceMarginBps: 11_000n,
      sponsorName: 'tornado-4337-relayer (e2e)',
    },
    { info: (m, meta) => log(`relayer: ${m} ${meta ? JSON.stringify(meta) : ''}`), warn: (m) => log(`relayer WARN: ${m}`) },
  );
  const relayerPort = opts.relayerPort ?? 8787 + Math.floor(Math.random() * 500);
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
    deployer,
    relayerSigner,
    instance,
    denomination,
    instanceDeployBlock,
    paymaster,
    zap,
    relayer,
    setBalance,
    mine,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      await altoInstance.stop();
      await anvilInstance.stop();
    },
  };
}
