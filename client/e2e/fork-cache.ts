/**
 * Pinned-fork fixtures committed to the repo: anvil's RPC cache for the pinned block (every account,
 * storage slot and code the suites touch upstream) and the canonical pools' deposit leaves. Restored
 * into anvil's cache directory before a fork starts, so a fresh clone runs the mainnet suites without
 * pulling state from an archive node; `pnpm fork-cache:save` writes a warm cache back into the repo.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, 'fork-cache');

const chainDir = (chainId: number) => ({ 1: 'mainnet', 11155111: 'sepolia' })[chainId] ?? String(chainId);

/** anvil / forge RPC cache file for a pinned block. */
export function anvilCachePath(chainId: number, block: bigint): string {
  return join(homedir(), '.foundry', 'cache', 'rpc', chainDir(chainId), block.toString(), 'storage.json');
}

export function fixturePath(chainId: number, block: bigint): string {
  return join(FIXTURE_DIR, `${chainDir(chainId)}-${block}.storage.json.gz`);
}

async function gunzipTo(src: string, dst: string) {
  mkdirSync(dirname(dst), { recursive: true });
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dst));
}

async function gzipTo(src: string, dst: string) {
  mkdirSync(dirname(dst), { recursive: true });
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dst));
}

/** Seed anvil's cache from the repo fixture when anvil has nothing (or something smaller) for that block. */
export async function restoreForkCache(chainId: number, block: bigint, log?: (m: string) => void): Promise<void> {
  const fixture = fixturePath(chainId, block);
  if (!existsSync(fixture)) return;
  const target = anvilCachePath(chainId, block);
  if (existsSync(target)) return; // anvil already has a (possibly warmer) cache for this block
  await gunzipTo(fixture, target);
  log?.(`restored anvil cache for block ${block} from ${fixture} (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
}

/** Copy anvil's cache for every pinned block back into the repo (run after a warm pass of the suites). */
export async function saveForkCaches(blocks: Record<number, bigint>): Promise<string[]> {
  const saved: string[] = [];
  for (const [chainIdStr, block] of Object.entries(blocks)) {
    const chainId = Number(chainIdStr);
    const src = anvilCachePath(chainId, block);
    if (!existsSync(src)) continue;
    await gzipTo(src, fixturePath(chainId, block));
    saved.push(fixturePath(chainId, block));
  }
  return saved;
}

export function listFixtures(): string[] {
  return existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR) : [];
}
