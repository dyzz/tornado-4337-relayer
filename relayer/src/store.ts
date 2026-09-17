import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Hex } from 'viem';

import { MemorySponsorshipStore, type SponsoredNote } from './service.js';

/**
 * Sponsorships persisted to a JSON file (atomic rename on every write) so a restart cannot sign a
 * second sponsorship for a note whose first one is still valid. Single-process only.
 */
export class FileSponsorshipStore extends MemorySponsorshipStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
        string,
        {
          validUntil: number;
          sender: `0x${string}`;
          nonce: string;
          status?: 'pending' | 'signed';
          token?: string;
          maxGasCostWei?: string;
        }
      >;
      // Only signed sponsorships matter across a restart; a pending one died with the process.
      for (const [k, v] of Object.entries(raw)) {
        if (v.status !== 'signed') continue;
        this.notes.set(k as Hex, {
          ...v,
          nonce: BigInt(v.nonce),
          // A restored sponsorship still counts against the deposit budget until it expires.
          maxGasCostWei: v.maxGasCostWei === undefined ? undefined : BigInt(v.maxGasCostWei),
          status: 'signed',
          token: v.token ?? 'restored',
        });
      }
    }
  }

  protected override set(k: Hex, v: SponsoredNote) {
    super.set(k, v);
    this.flush();
  }

  protected override delete(k: Hex) {
    super.delete(k);
    this.flush();
  }

  override prune(now: number) {
    const before = this.notes.size;
    super.prune(now);
    if (this.notes.size !== before) this.flush();
  }

  private flush() {
    const obj: Record<string, unknown> = {};
    // JSON has no bigint: every numeric field is written as a decimal string and parsed back above.
    for (const [k, v] of this.notes) {
      obj[k] = { ...v, nonce: v.nonce.toString(), maxGasCostWei: v.maxGasCostWei?.toString() };
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, this.path);
  }
}
