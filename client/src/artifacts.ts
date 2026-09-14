import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TC_CIRCUIT_URL =
  'https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornado.json';
const TC_PROVING_KEY_URL =
  'https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornadoProvingKey.bin';

export interface TornadoArtifacts {
  circuit: object;
  /** Raw `tornado.json` text (what `@kohaku-eth/tornado-cash`'s artifactsLoader expects). */
  circuitText: string;
  provingKey: ArrayBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ARTIFACTS_DIR = join(here, '..', 'artifacts');

/**
 * Load `tornado.json` + `tornadoProvingKey.bin`. Order of precedence:
 *  1. `TORNADO_ARTIFACTS_DIR` env (or `dir` argument) containing both files
 *  2. a local cache under client/artifacts
 *  3. download from the tornado-cli repository into that cache
 */
export async function loadArtifacts(dir = process.env.TORNADO_ARTIFACTS_DIR): Promise<TornadoArtifacts> {
  const candidates = [dir, DEFAULT_ARTIFACTS_DIR].filter((d): d is string => !!d);
  for (const d of candidates) {
    const circuit = join(d, 'tornado.json');
    const key = join(d, 'tornadoProvingKey.bin');
    if (existsSync(circuit) && existsSync(key)) return read(circuit, key);
  }

  mkdirSync(DEFAULT_ARTIFACTS_DIR, { recursive: true });
  const circuitPath = join(DEFAULT_ARTIFACTS_DIR, 'tornado.json');
  const keyPath = join(DEFAULT_ARTIFACTS_DIR, 'tornadoProvingKey.bin');
  const [circuitRes, keyRes] = await Promise.all([fetch(TC_CIRCUIT_URL), fetch(TC_PROVING_KEY_URL)]);
  if (!circuitRes.ok || !keyRes.ok) throw new Error('failed to download tornado circuit artifacts');
  writeFileSync(circuitPath, Buffer.from(await circuitRes.arrayBuffer()));
  writeFileSync(keyPath, Buffer.from(await keyRes.arrayBuffer()));
  return read(circuitPath, keyPath);
}

function read(circuitPath: string, keyPath: string): TornadoArtifacts {
  const key = readFileSync(keyPath);
  const circuitText = readFileSync(circuitPath, 'utf8');
  return {
    circuit: JSON.parse(circuitText),
    circuitText,
    provingKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
  };
}
