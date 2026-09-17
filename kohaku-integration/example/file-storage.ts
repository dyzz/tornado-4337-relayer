import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The Kohaku host `Storage` interface (two async methods over string keys), backed by a JSON file.
 *
 * The SDK keeps its Tornado sync state here — the deposit tree it has scanned and the notes it has
 * decrypted, under a `${address}.${chainId}` key. With `MemoryStorage` that state dies with the
 * process, so every run rescans the pool from its deployment block: about twenty minutes against a
 * public RPC, repeated for each shield, each balance check and each withdrawal.
 *
 * Persisting it makes every run after the first incremental. Writes go through a temporary file and a
 * rename, so a process killed mid-write leaves the previous state rather than a truncated one.
 *
 * The file holds the wallet's decrypted note state. Keep it with the same care as the mnemonic: this
 * example writes it under a path the repository ignores.
 */
export class FileStorage {
  readonly _brand = 'Storage' as const;
  private readonly data: Record<string, string>;

  constructor(private readonly path: string) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
  }

  async get(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
}
