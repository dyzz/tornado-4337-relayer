import { createPublicClient, getAddress, http, isAddress, isHex, type Address, type Hex } from 'viem';
import { FixedPriceSource, ONEINCH_OFFCHAIN_ORACLE_MAINNET, OneInchPriceSource, type PriceSource } from './price.js';
import type { RelayerConfig } from './service.js';

const ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env ${name}`);
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

/** Build a RelayerConfig from environment variables (see .env.example). */
export function configFromEnv(): RelayerConfig {
  const signerKey = env('RELAYER_PRIVATE_KEY');
  if (!isHex(signerKey) || signerKey.length !== 66) throw new Error('RELAYER_PRIVATE_KEY must be a 32-byte hex key');
  const chainId = BigInt(env('CHAIN_ID', '1'));
  const rpcUrl = env('RPC_URL');
  return {
    chainId,
    rpcUrl,
    bundlerUrl: process.env.BUNDLER_URL || undefined,
    entryPoint: addr('ENTRY_POINT', ENTRY_POINT_V08),
    paymaster: addr('PAYMASTER_ADDRESS'),
    signerKey: signerKey as Hex,
    instances: env('TORNADO_INSTANCES')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (!isAddress(s)) throw new Error(`TORNADO_INSTANCES entry is not an address: ${s}`);
        return getAddress(s);
      }),
    priceSource: priceSourceFromEnv(rpcUrl, chainId),
    serviceFeeBps: BigInt(env('SERVICE_FEE_BPS', '30')),
    signatureTtlSec: Number(env('SIGNATURE_TTL_SEC', '300')),
    simulateWithBundler: env('SIMULATE_WITH_BUNDLER', 'true') === 'true',
    gasPriceMarginBps: BigInt(env('GAS_PRICE_MARGIN_BPS', '11000')),
    sponsorName: env('SPONSOR_NAME', 'tornado-4337-relayer'),
  };
}
