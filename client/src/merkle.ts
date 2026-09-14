import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMimcMerkleTree, generateMimcMerkleProof } from '@kohaku-eth/mimc-tree';
import { hexToBigInt, type Address, type PublicClient } from 'viem';
import { tornadoAbi } from './abi.js';

export interface LeafCache {
  instance: Address;
  chainId: number;
  lastBlock: string;
  /** commitments as decimal strings, ordered by leafIndex */
  leaves: string[];
}

export interface SyncOptions {
  /** Block the instance was deployed at (start of the scan when no cache exists). */
  fromBlock: bigint;
  /** eth_getLogs range per request; public RPCs typically cap this. */
  chunk?: bigint;
  /** JSON file to persist leaves between runs. */
  cacheFile?: string;
  log?: (msg: string) => void;
}

/** Fetch every `Deposit` leaf of a Tornado instance, resuming from a cache when present. */
export async function syncLeaves(client: PublicClient, instance: Address, opts: SyncOptions): Promise<LeafCache> {
  const chainId = await client.getChainId();
  let cache: LeafCache = { instance, chainId, lastBlock: (opts.fromBlock - 1n).toString(), leaves: [] };
  if (opts.cacheFile && existsSync(opts.cacheFile)) {
    const loaded = JSON.parse(readFileSync(opts.cacheFile, 'utf8')) as LeafCache;
    if (loaded.instance.toLowerCase() === instance.toLowerCase() && loaded.chainId === chainId) cache = loaded;
  }

  const head = await client.getBlockNumber();
  const chunk = opts.chunk ?? 5_000n;
  let from = BigInt(cache.lastBlock) + 1n;
  const events: { leafIndex: number; commitment: bigint }[] = [];

  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await client.getLogs({
      address: instance,
      event: tornadoAbi[0],
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      events.push({ leafIndex: Number(l.args.leafIndex), commitment: hexToBigInt(l.args.commitment!) });
    }
    opts.log?.(`synced ${instance} blocks ${from}-${to}: +${logs.length} leaves (total ${cache.leaves.length + events.length})`);
    from = to + 1n;
  }

  events.sort((a, b) => a.leafIndex - b.leafIndex);
  for (const e of events) {
    if (e.leafIndex !== cache.leaves.length) {
      throw new Error(`leaf index gap: expected ${cache.leaves.length}, got ${e.leafIndex}`);
    }
    cache.leaves.push(e.commitment.toString());
  }
  cache.lastBlock = head.toString();

  if (opts.cacheFile) {
    mkdirSync(dirname(opts.cacheFile), { recursive: true });
    writeFileSync(opts.cacheFile, JSON.stringify(cache));
  }
  return cache;
}

export interface MerklePath {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
  leafIndex: number;
}

/** Merkle path for `commitment` in the MiMC tree built from `leaves` (levels = 20). */
export function merklePath(leaves: (bigint | string)[], commitment: bigint): MerklePath {
  const asBigints = leaves.map((l) => BigInt(l));
  const leafIndex = asBigints.findIndex((l) => l === commitment);
  if (leafIndex < 0) throw new Error('commitment not found in the deposit tree');
  const tree = createMimcMerkleTree(asBigints);
  const { root, siblings, pathIndices } = generateMimcMerkleProof(tree, commitment);
  return { root, pathElements: siblings, pathIndices, leafIndex };
}
