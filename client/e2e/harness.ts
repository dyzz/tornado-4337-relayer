import { serve, type ServerType } from '@hono/node-server';
import { Instance } from 'prool';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseEther,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  createRelayerApp,
  FixedPriceSource,
  OneInchPriceSource,
  RelayerService,
  type PriceSource,
} from '@tornado-4337/relayer';
import { CHAINS, type ChainSetup } from '../src/chains.js';
import { deployErc20Tornado, deployEthTornado, deployMimcHasher, deployPaymaster, deployZap } from '../src/deploy.js';
import { erc20Abi, paymasterAdminAbi } from '../src/abi.js';

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
  /** ERC-20 pool for `setup.demoErc20` (fresh on forks, canonical in canonicalInstances mode). */
  erc20Instance: Address;
  erc20Denomination: bigint;
  paymaster: Address;
  zap: Address;
  relayer: RelayerService;
  setBalance(address: Address, wei: bigint): Promise<void>;
  /** A brand-new EOA funded with `wei` (default 10 ETH). */
  newFundedAccount(wei?: bigint): Promise<ReturnType<typeof privateKeyToAccount>>;
  /** Give `to` some of the demo ERC-20 (storage write on mainnet-style tokens, whale transfer otherwise). */
  dealErc20(to: Address, amount: bigint): Promise<void>;
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
    instance = setup.tornadoEth['0.1']!;
    denomination = parseEther('0.1');
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
  log(`deployed tornado=${instance} tornado-${setup.demoErc20.symbol}=${erc20Instance} paymaster=${paymaster} zap=${zap} hasher=${hasher}`);

  // --- alto -----------------------------------------------------------------
  const altoPort = opts.altoPort ?? 4337 + Math.floor(Math.random() * 500);
  const altoInstance = Instance.alto({
    rpcUrl,
    entrypoints: [setup.entryPoint],
    executorPrivateKeys: [executorKey],
    utilityPrivateKey: utilityKey,
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
  const priceSource: PriceSource =
    chain.id === 1
      ? new OneInchPriceSource(createPublicClient({ chain, transport: http(rpcUrl, { timeout: 600_000 }) }))
      : new FixedPriceSource({ [setup.demoErc20.address]: '3000' });
  if (chain.id === 1) {
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
      instances: opts.canonicalInstances
        ? [...Object.values(setup.tornadoEth), erc20Instance]
        : [instance, erc20Instance],
      priceSource,
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
    erc20Instance,
    erc20Denomination,
    paymaster,
    zap,
    relayer,
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
