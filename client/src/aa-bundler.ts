/**
 * The eth-infinitism reference bundler as the ERC-7562 rule oracle: `scripts/erc7562-check.ts` loads its
 * validation rule engine (collector tracer + result parser) in-process. The checkout is pinned to one
 * commit so "passes the reference bundler rules" always means one specific rule set.
 */
import { execFileSync } from 'node:child_process';

/** eth-infinitism/bundler commit (validation-manager 0.8.0) the checks are pinned to. */
export const AA_BUNDLER_COMMIT = 'aae77140e5c2b1386d04eaeba2d23fc17a62bd87';

/**
 * `AA_BUNDLER_DIR`: a built checkout of github.com/eth-infinitism/bundler at `AA_BUNDLER_COMMIT`
 * (`git checkout <commit> && yarn && yarn preprocess && yarn build`). A different commit is refused
 * unless `AA_BUNDLER_ALLOW_UNPINNED=1`, so results always refer to one known rule set.
 */
export function resolveBundlerDir(): string {
  const dir = process.env.AA_BUNDLER_DIR;
  if (!dir) throw new Error('AA_BUNDLER_DIR must point at a built eth-infinitism/bundler checkout');
  let head: string;
  try {
    head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`AA_BUNDLER_DIR=${dir} is not a git checkout: ${(err as Error).message}`);
  }
  if (head !== AA_BUNDLER_COMMIT) {
    const msg = `AA_BUNDLER_DIR is at ${head}; the checks are pinned to ${AA_BUNDLER_COMMIT}`;
    if (!process.env.AA_BUNDLER_ALLOW_UNPINNED) throw new Error(`${msg} (AA_BUNDLER_ALLOW_UNPINNED=1 to run anyway)`);
    console.warn(`[aa-bundler] ${msg} (running unpinned)`);
  }
  return dir;
}
