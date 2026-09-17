import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, isHex, type Hex } from 'viem';

import { MemorySponsorshipStore, type SponsoredNote } from './service.js';

/** On-disk form of a signed sponsorship. JSON has no bigint: numeric fields are decimal strings. */
interface StoredNote {
  validUntil: number;
  sender: string;
  nonce: string;
  status: 'signed';
  token: string;
  /** Absent in files written before the deposit budget existed; see `committedGasCost`. */
  maxGasCostWei?: string;
}

/**
 * Sponsorships persisted to a JSON file, so a restart cannot sign a second sponsorship for a note whose
 * first one is still valid. Single-process only.
 *
 * Only signed entries are written, and each one is written *before* it becomes visible in memory: the
 * whole file is rewritten to a temporary path and renamed over the old one, and only then is the entry
 * marked signed. A write that fails therefore leaves both the file and the memory as they were, the
 * signing request fails, and its pending reservation is released by the caller — nothing is left
 * holding the note. Pending reservations are never written at all.
 *
 * Loading is strict: an unreadable or malformed file stops the service rather than starting empty,
 * because starting empty would allow a second signature for a note whose first is still live. Entries
 * that have expired are dropped. Live entries from a release that did not record `maxGasCostWei` are
 * kept and counted in `legacyEntries`; while any of them is live the budget is unknown and no new
 * sponsorship is signed (`committedGasCost`).
 *
 * The constructor also writes the file once, so a store that cannot be written fails at start-up and
 * not on the first request.
 */
export class FileSponsorshipStore extends MemorySponsorshipStore {
  /** Live entries restored without a recorded gas cost. */
  readonly legacyEntries: number;

  constructor(
    private readonly path: string,
    now: number = Math.floor(Date.now() / 1000),
  ) {
    super();
    let legacy = 0;
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<StoredNote> & { status?: string }>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: not a sponsorship store`);
      for (const [key, v] of Object.entries(raw)) {
        // Pending entries (written by older releases) belonged to requests that died with that process.
        if (v.status !== 'signed') continue;
        if (!isHex(key) || key.length !== 66) throw new Error(`${path}: malformed nullifier hash ${key}`);
        if (typeof v.validUntil !== 'number' || typeof v.nonce !== 'string' || typeof v.sender !== 'string') {
          throw new Error(`${path}: malformed entry for ${key}`);
        }
        if (v.validUntil < now) continue;
        const note: SponsoredNote = {
          validUntil: v.validUntil,
          sender: getAddress(v.sender),
          nonce: BigInt(v.nonce),
          status: 'signed',
          token: v.token ?? 'restored',
          maxGasCostWei: v.maxGasCostWei === undefined ? undefined : BigInt(v.maxGasCostWei),
        };
        if (note.maxGasCostWei === undefined) legacy++;
        this.notes.set(key as Hex, note);
      }
    }
    this.legacyEntries = legacy;
    // Rewrite now: proves the location is writable, and drops expired and pending leftovers.
    this.write(this.signedEntries());
  }

  protected override persistSigned(k: Hex, next: SponsoredNote): void {
    const entries = this.signedEntries();
    entries.set(k, next);
    this.write(entries);
  }

  private signedEntries(): Map<Hex, SponsoredNote> {
    const out = new Map<Hex, SponsoredNote>();
    for (const [k, v] of this.notes) if (v.status === 'signed') out.set(k, v);
    return out;
  }

  private write(entries: Map<Hex, SponsoredNote>): void {
    const obj: Record<string, StoredNote> = {};
    for (const [k, v] of entries) {
      obj[k] = {
        validUntil: v.validUntil,
        sender: v.sender,
        nonce: v.nonce.toString(),
        status: 'signed',
        token: v.token,
        ...(v.maxGasCostWei === undefined ? {} : { maxGasCostWei: v.maxGasCostWei.toString() }),
      };
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, this.path);
  }
}
