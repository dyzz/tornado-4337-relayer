/**
 * Host-side `ExternalSyncProvider` for the Kohaku SDK that fetches pool events
 * itself with small chunks, retries, and a completeness check on `Deposit`
 * leaf indices. Public RPCs silently drop logs on large `eth_getLogs` ranges,
 * which makes the SDK's local merkle root diverge from the pool; this provider
 * refuses to hand over a gap-ridden range.
 */
import { keccak256, numberToHex, stringToBytes, type Address, type Hex, type PublicClient } from 'viem';
import type { ExternalRawEvent, ExternalSyncPoolId, ExternalSyncProvider } from '@kohaku-eth/plugins';

const DEPOSIT_TOPIC = keccak256(stringToBytes('Deposit(bytes32,uint32,uint256)'));

export interface RobustSyncProviderParams {
  client: PublicClient;
  chainId: number;
  /** Lowest block this provider serves (the SDK's snapshot block). */
  firstBlock: bigint;
  /** Highest block this provider serves (fork head at creation). */
  lastBlock: bigint;
  chunk?: bigint;
  /** For pool addresses: leaf index the first fetched Deposit must have (leaves already in the snapshot). */
  expectedFirstLeafIndex?: (address: Address) => number | undefined;
  /** On-chain `nextIndex` of a pool at `lastBlock`, to check the last fetched leaf. */
  nextIndexAtHead?: (address: Address) => Promise<number | undefined>;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRobustSyncProvider(p: RobustSyncProviderParams): ExternalSyncProvider {
  const log = p.log ?? (() => {});
  const chunk = p.chunk ?? 1_000n;

  async function fetchRange(address: Address, from: bigint, to: bigint) {
    const out: ExternalRawEvent[] = [];
    for (let start = from; start <= to; start += chunk) {
      const end = start + chunk - 1n > to ? to : start + chunk - 1n;
      let attempt = 0;
      for (;;) {
        try {
          const logs = await p.client.getLogs({ address, fromBlock: start, toBlock: end });
          for (const l of logs) {
            out.push({
              contractAddress: l.address.toLowerCase() as Hex,
              eventTopic: l.topics[0]!.toLowerCase() as Hex,
              topics: l.topics.map((t) => t.toLowerCase() as Hex),
              data: l.data.toLowerCase() as Hex,
              blockNumber: numberToHex(l.blockNumber!),
              logIndex: numberToHex(l.logIndex!),
            });
          }
          break;
        } catch (err) {
          if (++attempt > 5) throw err;
          await sleep(500 * attempt);
        }
      }
    }
    out.sort((a, b) => {
      const d = Number(BigInt(a.blockNumber) - BigInt(b.blockNumber));
      return d !== 0 ? d : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
    });
    return out;
  }

  function depositIndices(events: ExternalRawEvent[]): number[] {
    return events
      .filter((e) => e.eventTopic === DEPOSIT_TOPIC)
      .map((e) => Number(BigInt(`0x${e.data.slice(2, 66)}`)))
      .sort((a, b) => a - b);
  }

  async function fetchComplete(address: Address, from: bigint, to: bigint): Promise<ExternalRawEvent[]> {
    const expectedFirst = p.expectedFirstLeafIndex?.(address);
    const expectedLast = to === p.lastBlock && p.nextIndexAtHead ? await p.nextIndexAtHead(address) : undefined;
    for (let pass = 1; pass <= 4; pass++) {
      const events = await fetchRange(address, from, to);
      const idx = depositIndices(events);
      const gaps: string[] = [];
      for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1]! + 1) gaps.push(`${idx[i - 1]}->${idx[i]}`);
      if (expectedFirst !== undefined && idx.length > 0 && idx[0] !== expectedFirst) gaps.push(`first ${idx[0]} != ${expectedFirst}`);
      if (expectedLast !== undefined && idx.length > 0 && idx[idx.length - 1] !== expectedLast - 1) {
        gaps.push(`last ${idx[idx.length - 1]} != ${expectedLast - 1}`);
      }
      log(`external sync ${address} [${from}, ${to}] pass ${pass}: ${events.length} events, ${idx.length} deposits${gaps.length ? `, gaps: ${gaps.join(' ')}` : ''}`);
      if (gaps.length === 0) return events;
      await sleep(1_000 * pass);
    }
    throw new Error(`could not fetch a gap-free event range for ${address}`);
  }

  const assertPool = ({ chainId }: ExternalSyncPoolId) => {
    if (Number(BigInt(chainId)) !== p.chainId) throw new Error('unsupported chain');
  };

  return {
    async *streamEvents(params) {
      assertPool(params);
      const from = BigInt(params.fromBlock) < p.firstBlock ? p.firstBlock : BigInt(params.fromBlock);
      const to = BigInt(params.toBlock) > p.lastBlock ? p.lastBlock : BigInt(params.toBlock);
      if (from > to) return;
      for (const e of await fetchComplete(params.address as Address, from, to)) yield e;
    },
    async firstCoveredBlock(params) {
      assertPool(params);
      return numberToHex(p.firstBlock);
    },
    async lastCoveredBlock(params) {
      assertPool(params);
      return numberToHex(p.lastBlock);
    },
  };
}
