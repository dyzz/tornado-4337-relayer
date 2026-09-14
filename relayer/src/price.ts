import { parseAbi, type Address, type PublicClient } from 'viem';
import { RATE_SCALE } from './userop.js';

/**
 * Token pricing for ERC-20 instances. `tokenPerEth` is what the relayer signs
 * and the paymaster settles at: fee-token base units equal to 1 ETH (1e18 wei).
 */
export interface PriceSource {
  tokenPerEth(token: Address, decimals: number): Promise<bigint>;
}

/** 1inch OffchainOracle (what tornado-relayer's priceWatcher uses). Mainnet: 0x07D91f5fb9Bf7798734C3f606dB065549F6893bb */
export const ONEINCH_OFFCHAIN_ORACLE_MAINNET: Address = '0x07D91f5fb9Bf7798734C3f606dB065549F6893bb';
/** cDAI needs the oracle's wrapper resolution, exactly as the original relayer does. */
const WRAPPED_TOKENS = new Set(['0x5d3a536e4d6dbd6114cc1ead35777bab948e3643']);

const oracleAbi = parseAbi(['function getRateToEth(address srcToken, bool useSrcWrappers) view returns (uint256)']);

/**
 * `getRateToEth` returns wei per 1 token scaled by 1e18 / 10^decimals, i.e.
 * `rate * 10^decimals / 1e18` = wei per whole token. tokenPerEth is the inverse
 * in base units: 1e18 * 10^decimals / weiPerToken.
 */
export class OneInchPriceSource implements PriceSource {
  private cache = new Map<string, { value: bigint; at: number }>();

  constructor(
    private readonly client: PublicClient,
    private readonly oracle: Address = ONEINCH_OFFCHAIN_ORACLE_MAINNET,
    private readonly ttlMs = 30_000,
  ) {}

  async tokenPerEth(token: Address, decimals: number): Promise<bigint> {
    const key = token.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const rate = await this.client.readContract({
      address: this.oracle,
      abi: oracleAbi,
      functionName: 'getRateToEth',
      args: [token, WRAPPED_TOKENS.has(key)],
    });
    const one = 10n ** BigInt(decimals);
    const weiPerToken = (rate * one) / RATE_SCALE;
    if (weiPerToken === 0n) throw new Error(`oracle returned a zero price for ${token}`);
    const value = (RATE_SCALE * one) / weiPerToken;
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** Tornado `/status` convention: wei per whole token. */
  async weiPerToken(token: Address, decimals: number): Promise<bigint> {
    const one = 10n ** BigInt(decimals);
    return (RATE_SCALE * one) / (await this.tokenPerEth(token, decimals));
  }
}

/** Fixed prices for testnets (no on-chain oracle). Configured as whole tokens per ETH, e.g. "3000". */
export class FixedPriceSource implements PriceSource {
  private readonly prices = new Map<string, string>();

  constructor(tokensPerEth: Record<string, string>) {
    for (const [token, price] of Object.entries(tokensPerEth)) this.prices.set(token.toLowerCase(), price);
  }

  async tokenPerEth(token: Address, decimals: number): Promise<bigint> {
    const price = this.prices.get(token.toLowerCase());
    if (price === undefined) throw new Error(`no fixed price configured for ${token}`);
    return parseDecimal(price, decimals);
  }
}

/** "3000" -> 3000 * 10^decimals; "0.03" -> 0.03 * 10^decimals (WBTC per ETH). */
export function parseDecimal(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid decimal ${value}`);
  const [, whole, frac = ''] = m;
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole! + fracPadded);
}

export function weiPerTokenFrom(tokenPerEth: bigint, decimals: number): bigint {
  const one = 10n ** BigInt(decimals);
  return (RATE_SCALE * one) / tokenPerEth;
}
