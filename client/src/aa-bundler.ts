/**
 * The eth-infinitism reference bundler as the strict ERC-4337 / ERC-7562 acceptance oracle.
 *
 * Two consumers: `scripts/erc7562-check.ts` loads its validation rule engine (tracer + parser) in-process,
 * and the e2e harness runs the whole bundler in *safe mode* (no `--unsafe`: every op is traced with
 * `debug_traceCall` and checked against the ERC-7562 rules before it is accepted into the mempool).
 * Both pin the checkout to one commit so "passes the reference bundler" means one specific rule set.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';

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

export interface ReferenceBundlerOptions {
  dir: string;
  rpcUrl: string;
  chainId: number;
  entryPoint: Address;
  /** BIP-39 mnemonic of the bundler's signer (the bundler only reads mnemonics); account 0 pays for bundles. */
  mnemonic: string;
  beneficiary: Address;
  port: number;
  privateApiPort: number;
  /** Reputation thresholds for paymasters/factories (defaults are the bundler's own: 1 ETH, 1 day). */
  minStakeEth?: string;
  minUnstakeDelaySec?: number;
  /**
   * native (default): geth's built-in `erc7562Tracer` on the network node (geth >= 1.15).
   * js: the bundler's JavaScript collector tracer via `--tracerRpcUrl` (same node). At the pinned
   * commit this path no longer decodes validation results — kept only to document the launch shape.
   */
  tracer?: 'native' | 'js';
  log?: (msg: string) => void;
}

export interface ReferenceBundler {
  /** JSON-RPC endpoint (`…/rpc`). */
  url: string;
  /** Everything the process printed so far. */
  output(): string;
  stop(): Promise<void>;
}

/** Start `exec.js` in safe mode with `--auto` (bundle as soon as an op is accepted) and wait until it serves RPC. */
export async function startReferenceBundler(o: ReferenceBundlerOptions): Promise<ReferenceBundler> {
  const log = o.log ?? (() => {});
  const workdir = mkdtempSync(join(tmpdir(), 'aa-bundler-'));
  const mnemonicFile = join(workdir, 'mnemonic.txt');
  writeFileSync(mnemonicFile, o.mnemonic, { mode: 0o600 });
  const config = {
    chainId: o.chainId,
    gasFactor: '1',
    port: String(o.port),
    privateApiPort: String(o.privateApiPort),
    network: o.rpcUrl,
    entryPoint: o.entryPoint,
    beneficiary: o.beneficiary,
    minBalance: '1',
    mnemonic: mnemonicFile,
    maxBundleGas: 10_000_000,
    minStake: o.minStakeEth ?? '1',
    minUnstakeDelay: o.minUnstakeDelaySec ?? 86_400,
    autoBundleInterval: 1,
    autoBundleMempoolSize: 1,
    // explicit: the whole point of this run
    unsafe: false,
    eip7702Support: true,
    // Without tracerRpcUrl the bundler traces with geth's native `erc7562Tracer` on the network node.
    ...(o.tracer === 'js' ? { tracerRpcUrl: o.rpcUrl } : {}),
  };
  const configFile = join(workdir, 'bundler.config.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));

  const exec = join(o.dir, 'packages', 'bundler', 'dist', 'src', 'exec.js');
  const child: ChildProcess = spawn(process.execPath, [exec, '--config', configFile, '--auto'], {
    cwd: workdir,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const onData = (d: Buffer) => {
    output += d.toString();
    for (const line of d.toString().split('\n')) if (line.trim()) log(`bundler: ${line}`);
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      resolve();
    });
  });

  const url = `http://127.0.0.1:${o.port}/rpc`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error(`reference bundler exited (${exited.code ?? exited.signal}) before serving:\n${output}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }),
      });
      const body = (await res.json()) as { result?: string[] };
      if (body.result?.some((e) => e.toLowerCase() === o.entryPoint.toLowerCase())) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`reference bundler did not come up within 90 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    output: () => output,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5_000))]);
      if (!exited) child.kill('SIGKILL');
    },
  };
}
