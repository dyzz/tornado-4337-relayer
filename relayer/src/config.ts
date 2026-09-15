import { createPublicClient, getAddress, http, isAddress, isHex, type Address, type Hex } from 'viem';
import { FixedPriceSource, ONEINCH_OFFCHAIN_ORACLE_MAINNET, OneInchPriceSource, type PriceSource } from './price.js';
import type { RelayerConfig } from './service.js';
import { DEFAULT_STAKE_WEI, DEFAULT_UNSTAKE_DELAY_SEC, type PaymasterSetupConfig } from './setup.js';

const ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

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

/** Per-chain deployments of TornadoRelayerPaymaster7702 (the shared 7702 implementation). */
export const PAYMASTER_7702_IMPLEMENTATIONS: Record<string, Address> = {};

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
 *   PAYMASTER_MODE            7702 (default when PAYMASTER_ADDRESS is unset: the relayer key's own address
 *                             is the paymaster) | standalone (PAYMASTER_ADDRESS = deployed contract)
 *   PAYMASTER_IMPLEMENTATION  7702 implementation to delegate to (per-chain default when known)
 *   AUTO_SETUP                send delegation / stake / deposit transactions when missing (default true)
 *   PAYMASTER_STAKE_WEI       EntryPoint stake to keep (default 0.1 ETH), UNSTAKE_DELAY_SEC (default 86400)
 *   PAYMASTER_DEPOSIT_WEI     minimum EntryPoint deposit to keep (default 0 = never top up)
 */
export function setupConfigFromEnv(): PaymasterSetupConfig {
  const signerKey = env('RELAYER_PRIVATE_KEY');
  if (!isHex(signerKey) || signerKey.length !== 66) throw new Error('RELAYER_PRIVATE_KEY / PRIVATE_KEY must be a 32-byte hex key');
  const chainId = BigInt(env('CHAIN_ID', '1'));
  const hasAddress = Boolean(process.env.PAYMASTER_ADDRESS);
  const mode = env('PAYMASTER_MODE', hasAddress ? 'standalone' : '7702') as PaymasterSetupConfig['mode'];
  if (mode !== '7702' && mode !== 'standalone') throw new Error(`unknown PAYMASTER_MODE ${mode}`);
  const implDefault = PAYMASTER_7702_IMPLEMENTATIONS[chainId.toString()];
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
  };
}

/** Build a RelayerConfig from environment variables (see .env.example). `paymaster` comes from the setup step. */
export function configFromEnv(paymaster: Address): RelayerConfig {
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
    bundlerUrl: process.env.BUNDLER_URL || undefined,
    entryPoint: addr('ENTRY_POINT', ENTRY_POINT_V08),
    paymaster,
    signerKey: signerKey as Hex,
    rewardAccount: process.env.REWARD_ACCOUNT ? addr('REWARD_ACCOUNT') : undefined,
    allowUnregistered: env('ALLOW_UNREGISTERED', 'false') === 'true',
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
    simulateWithBundler: env('SIMULATE_WITH_BUNDLER', 'true') === 'true',
    gasPriceMarginBps: BigInt(env('GAS_PRICE_MARGIN_BPS', '11000')),
    sponsorName: env('SPONSOR_NAME', 'tornado-4337-relayer'),
  };
}
