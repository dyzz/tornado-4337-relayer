import { createPublicClient, getAddress, http, isAddress, isHex, type Address, type Hex } from 'viem';
import { FixedPriceSource, ONEINCH_OFFCHAIN_ORACLE_MAINNET, OneInchPriceSource, type PriceSource } from './price.js';
import type { RelayerConfig } from './service.js';
import { FileSponsorshipStore } from './store.js';
import { DEFAULT_STAKE_WEI, DEFAULT_UNSTAKE_DELAY_SEC, type PaymasterSetupConfig } from './setup.js';

const ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

/**
 * The canonical EntryPoint v0.8 Simple7702Account, deployed at the same address on every chain. This
 * is the only account implementation sponsored by default: its `execute`/`executeBatch` really run the
 * calls the relayer validated, so the sponsored gas buys the withdrawal the relayer signed for.
 */
export const SIMPLE_7702_ACCOUNT: Address = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';

/**
 * `tornado-relayer` (the classic relayer) environment names are accepted as aliases, so an
 * existing `.env` keeps working: PRIVATE_KEY (worker key), REWARD_ACCOUNT, HTTP_RPC_URL, NET_ID,
 * RELAYER_FEE (percent).
 */
const ALIASES: Record<string, string> = {
  RELAYER_PRIVATE_KEY: 'PRIVATE_KEY',
  RPC_URL: 'HTTP_RPC_URL',
  CHAIN_ID: 'NET_ID',
};

/**
 * Per-chain deployments of TornadoRelayerPaymaster7702, the experimental variant where the relayer's own
 * EOA is the paymaster. Empty on purpose: the supported deployment is the standalone worker contract, and
 * the old Sepolia implementation predates the current sponsorship-terms layout. `PAYMASTER_MODE=7702` is
 * refused by `setupConfigFromEnv`; the contract and its tests stay in the tree for future work.
 */
export const PAYMASTER_7702_IMPLEMENTATIONS: Record<string, Address> = {};

/** Tornado DAO routers. Sepolia's is our sandbox copy (the DAO never deployed one there). */
export const TORNADO_ROUTERS: Record<string, Address> = {
  '1': '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b',
  '11155111': '0xF2DafFd789ec02211a8f1be1034165cFf759a04D',
};

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  const alias = ALIASES[name];
  if (alias && process.env[alias] !== undefined && process.env[alias] !== '') return process.env[alias]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env ${name}${alias ? ` (or ${alias})` : ''}`);
}

function addr(name: string, fallback?: string): Address {
  const v = env(name, fallback);
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return getAddress(v);
}

/**
 * Token price source from env:
 *   PRICE_SOURCE=oneinch  (default on mainnet) — 1inch OffchainOracle, ONEINCH_ORACLE overrides the address
 *   PRICE_SOURCE=fixed    — FIXED_TOKENS_PER_ETH="0xtoken:3000,0xother:0.03" (whole tokens per ETH)
 *   PRICE_SOURCE=none     — ETH instances only
 */
export function priceSourceFromEnv(rpcUrl: string, chainId: bigint): PriceSource | undefined {
  const mode = env('PRICE_SOURCE', chainId === 1n ? 'oneinch' : 'none');
  if (mode === 'none') return undefined;
  if (mode === 'oneinch') {
    const client = createPublicClient({ transport: http(rpcUrl) });
    return new OneInchPriceSource(client, addr('ONEINCH_ORACLE', ONEINCH_OFFCHAIN_ORACLE_MAINNET));
  }
  if (mode === 'fixed') {
    const prices: Record<string, string> = {};
    for (const entry of env('FIXED_TOKENS_PER_ETH').split(',')) {
      const [token, price] = entry.split(':').map((s) => s.trim());
      if (!token || !price || !isAddress(token)) throw new Error(`bad FIXED_TOKENS_PER_ETH entry: ${entry}`);
      prices[getAddress(token)] = price;
    }
    return new FixedPriceSource(prices);
  }
  throw new Error(`unknown PRICE_SOURCE ${mode}`);
}

/**
 * Paymaster setup from env:
 *   PAYMASTER_MODE            standalone (default): a TornadoRelayerPaymaster contract owned by the relayer key,
 *                             deployed by the service on first start unless PAYMASTER_ADDRESS is given;
 *                             7702 (experimental): the relayer key's own address delegates to PAYMASTER_IMPLEMENTATION
 *   TORNADO_ROUTER            DAO router wired into a freshly deployed contract (per-chain default)
 *   PAYMASTER_STATE_FILE      where the self-deployed address is remembered (default ./.paymaster-<chainId>.json)
 *   AUTO_SETUP                send deployment / delegation / stake / deposit transactions when missing (default true)
 *   PAYMASTER_STAKE_WEI       EntryPoint stake to keep (default 0.1 ETH), UNSTAKE_DELAY_SEC (default 86400)
 *   PAYMASTER_DEPOSIT_WEI     minimum EntryPoint deposit to keep (default 0 = never top up)
 *   WAIT_FOR_REGISTRATION     keep polling until the master has registered the paymaster as its worker (default true)
 *   GAS_MARGIN_BPS / POST_OP_GAS_OVERHEAD   parameters of a freshly deployed contract (1000 / 45000)
 */
export function setupConfigFromEnv(): PaymasterSetupConfig {
  const signerKey = env('RELAYER_PRIVATE_KEY');
  if (!isHex(signerKey) || signerKey.length !== 66) throw new Error('RELAYER_PRIVATE_KEY / PRIVATE_KEY must be a 32-byte hex key');
  const chainId = BigInt(env('CHAIN_ID', '1'));
  const hasAddress = Boolean(process.env.PAYMASTER_ADDRESS);
  const mode = env('PAYMASTER_MODE', 'standalone') as PaymasterSetupConfig['mode'];
  if (mode !== '7702' && mode !== 'standalone') throw new Error(`unknown PAYMASTER_MODE ${mode}`);
  const implDefault = PAYMASTER_7702_IMPLEMENTATIONS[chainId.toString()];
  const routerDefault = TORNADO_ROUTERS[chainId.toString()];
  return {
    chainId,
    rpcUrl: env('RPC_URL'),
    entryPoint: addr('ENTRY_POINT', ENTRY_POINT_V08),
    signerKey: signerKey as Hex,
    mode,
    paymaster: hasAddress ? addr('PAYMASTER_ADDRESS') : undefined,
    implementation: process.env.PAYMASTER_IMPLEMENTATION || implDefault ? addr('PAYMASTER_IMPLEMENTATION', implDefault) : undefined,
    autoSetup: env('AUTO_SETUP', 'true') === 'true',
    stakeWei: BigInt(env('PAYMASTER_STAKE_WEI', DEFAULT_STAKE_WEI.toString())),
    unstakeDelaySec: Number(env('UNSTAKE_DELAY_SEC', String(DEFAULT_UNSTAKE_DELAY_SEC))),
    depositWei: BigInt(env('PAYMASTER_DEPOSIT_WEI', '0')),
    router: process.env.TORNADO_ROUTER || routerDefault ? addr('TORNADO_ROUTER', routerDefault) : undefined,
    gasMarginBps: BigInt(env('GAS_MARGIN_BPS', '1000')),
    postOpGasOverhead: BigInt(env('POST_OP_GAS_OVERHEAD', '45000')),
    stateFile: env('PAYMASTER_STATE_FILE', `./.paymaster-${chainId}.json`),
    rewardAccount: process.env.REWARD_ACCOUNT ? addr('REWARD_ACCOUNT') : undefined,
    requireRegistration: true,
    waitForRegistration: env('WAIT_FOR_REGISTRATION', 'true') === 'true',
  };
}

/**
 * The sponsored account implementations. Default: the canonical Simple7702Account. Setting
 * ALLOWED_SENDER_IMPLEMENTATIONS narrows or replaces that list; setting it to an empty value is an
 * error, so there is no spelling of the configuration that means "sponsor any account".
 */
function allowedSenderImplementationsFromEnv(): Address[] {
  const raw = process.env.ALLOWED_SENDER_IMPLEMENTATIONS;
  if (raw === undefined) return [SIMPLE_7702_ACCOUNT];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!isAddress(s)) throw new Error(`ALLOWED_SENDER_IMPLEMENTATIONS entry is not an address: ${s}`);
      return getAddress(s);
    });
  if (list.length === 0) {
    throw new Error('ALLOWED_SENDER_IMPLEMENTATIONS is empty: leave it unset for the default (Simple7702Account)');
  }
  return list;
}

/** Build a RelayerConfig from environment variables (see .env.example). `paymaster` comes from the setup step. */
export function configFromEnv(paymaster: Address): RelayerConfig {
  // The pre-signing simulation is not optional. `SIMULATE_WITH_BUNDLER=true` from older .env files is
  // accepted as a no-op; any other value is refused rather than silently ignored.
  const simulate = process.env.SIMULATE_WITH_BUNDLER;
  if (simulate !== undefined && simulate !== '' && simulate !== 'true') {
    throw new Error(
      `SIMULATE_WITH_BUNDLER=${simulate}: the pre-signing bundler simulation cannot be disabled (remove the setting)`,
    );
  }
  const signerKey = env('RELAYER_PRIVATE_KEY');
  if (!isHex(signerKey) || signerKey.length !== 66) throw new Error('RELAYER_PRIVATE_KEY / PRIVATE_KEY must be a 32-byte hex key');
  const chainId = BigInt(env('CHAIN_ID', '1'));
  const rpcUrl = env('RPC_URL');
  // RELAYER_FEE is tornado-relayer's percentage (0.3 = 0.3 %); SERVICE_FEE_BPS wins when both are set.
  const serviceFeeBps = process.env.SERVICE_FEE_BPS
    ? BigInt(process.env.SERVICE_FEE_BPS)
    : process.env.RELAYER_FEE
      ? BigInt(Math.round(Number(process.env.RELAYER_FEE) * 100))
      : 30n;
  return {
    chainId,
    rpcUrl,
    // Required: `RelayerService.create` refuses to start without it, because every sponsorship is
    // simulated on the bundler before it is signed.
    bundlerUrl: env('BUNDLER_URL'),
    entryPoint: addr('ENTRY_POINT', ENTRY_POINT_V08),
    paymaster,
    signerKey: signerKey as Hex,
    rewardAccount: process.env.REWARD_ACCOUNT ? addr('REWARD_ACCOUNT') : undefined,
    allowUnregistered: env('ALLOW_UNREGISTERED', 'false') === 'true',
    // SPONSORSHIP_STORE=path keeps live sponsorships across restarts (single process).
    sponsorshipStore: process.env.SPONSORSHIP_STORE ? new FileSponsorshipStore(process.env.SPONSORSHIP_STORE) : undefined,
    // The account implementations this relayer sponsors. Defaults to the canonical Simple7702Account;
    // ALLOWED_SENDER_IMPLEMENTATIONS=0x…,0x… replaces that list (it never widens to "anything"), and an
    // empty value is refused rather than read as "no restriction".
    allowedSenderImplementations: allowedSenderImplementationsFromEnv(),
    instances: env('TORNADO_INSTANCES')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (!isAddress(s)) throw new Error(`TORNADO_INSTANCES entry is not an address: ${s}`);
        return getAddress(s);
      }),
    priceSource: priceSourceFromEnv(rpcUrl, chainId),
    serviceFeeBps,
    signatureTtlSec: Number(env('SIGNATURE_TTL_SEC', '300')),
    bundlerTimeoutMs: Number(env('BUNDLER_TIMEOUT_MS', '20000')),
    // Gas budget. The service never moves funds while it is serving: when the deposit cannot cover the
    // live sponsorships plus this reserve, it stops signing until someone tops it up.
    minDepositWei: BigInt(env('MIN_DEPOSIT_WEI', '0')),
    maxSponsorshipGasWei: process.env.MAX_SPONSORSHIP_GAS_WEI ? BigInt(process.env.MAX_SPONSORSHIP_GAS_WEI) : undefined,
    gasPriceMarginBps: BigInt(env('GAS_PRICE_MARGIN_BPS', '11000')),
    sponsorName: env('SPONSOR_NAME', 'tornado-4337-relayer'),
  };
}
