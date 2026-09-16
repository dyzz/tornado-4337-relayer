// After a warm run of the mainnet suites at the pinned block, copy anvil's RPC cache (and the
// canonical-pool leaf caches) into client/e2e/fork-cache so a fresh clone needs no archive node.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { FIXTURE_DIR, saveForkCaches } from '../e2e/fork-cache.js';
import { PINNED_FORK_BLOCKS } from '../e2e/harness.js';

const saved = await saveForkCaches({ 1: PINNED_FORK_BLOCKS.mainnet, 11155111: PINNED_FORK_BLOCKS.sepolia });
for (const f of saved) console.log('saved', f);
const leafDir = new URL('../.cache/', import.meta.url).pathname;
if (existsSync(leafDir)) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const f of readdirSync(leafDir).filter((f) => f.startsWith('leaves-') && f.endsWith('.json'))) {
    // Drop leaves a fork-local deposit added past the pinned block: the fixture is the chain's state at the pin.
    const chainId = Number(f.split('-')[1]);
    const pin = chainId === 1 ? PINNED_FORK_BLOCKS.mainnet : PINNED_FORK_BLOCKS.sepolia;
    const cache = JSON.parse(readFileSync(join(leafDir, f), 'utf8')) as { leaves: string[]; leafBlocks?: string[]; lastBlock: string };
    if (cache.leafBlocks) {
      let keep = 0;
      while (keep < cache.leafBlocks.length && BigInt(cache.leafBlocks[keep]!) <= pin) keep++;
      cache.leaves = cache.leaves.slice(0, keep);
      cache.leafBlocks = cache.leafBlocks.slice(0, keep);
      cache.lastBlock = pin.toString();
      writeFileSync(join(leafDir, f), JSON.stringify(cache));
    }
    const dst = join(FIXTURE_DIR, `${f}.gz`);
    await pipeline(createReadStream(join(leafDir, f)), createGzip({ level: 9 }), createWriteStream(dst));
    console.log('saved', dst, cache.leaves.length, 'leaves at block', cache.lastBlock);
  }
}
