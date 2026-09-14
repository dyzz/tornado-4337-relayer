import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
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

/** Build a RelayerConfig from environment variables (see .env.example). */
export function configFromEnv(): RelayerConfig {
  const signerKey = env('RELAYER_PRIVATE_KEY');
  if (!isHex(signerKey) || signerKey.length !== 66) throw new Error('RELAYER_PRIVATE_KEY must be a 32-byte hex key');
  return {
    chainId: BigInt(env('CHAIN_ID', '1')),
    rpcUrl: env('RPC_URL'),
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
    serviceFeeBps: BigInt(env('SERVICE_FEE_BPS', '30')),
    signatureTtlSec: Number(env('SIGNATURE_TTL_SEC', '300')),
    simulateWithBundler: env('SIMULATE_WITH_BUNDLER', 'true') === 'true',
    gasPriceMarginBps: BigInt(env('GAS_PRICE_MARGIN_BPS', '11000')),
    sponsorName: env('SPONSOR_NAME', 'tornado-4337-relayer'),
  };
}
