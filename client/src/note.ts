import { randomBytes } from 'node:crypto';
import { bytesToNumberLE, concatBytes, hexToBytes, numberToBytesLE } from '@noble/curves/utils.js';
import { pedersenHash as pedersenPoint, Point } from 'micro-zk-proofs/pedersen.js';
import { toHex, type Hex } from 'viem';

/** Pedersen hash as Tornado uses it: x-coordinate of the Baby Jubjub point. */
export function pedersenHash(msg: Uint8Array): bigint {
  return Point.decode(pedersenPoint(msg)).x;
}

export interface Note {
  nullifier: bigint;
  secret: bigint;
  commitment: bigint;
  nullifierHash: bigint;
  /** 62-byte preimage: nullifier (31 LE bytes) || secret (31 LE bytes). */
  preimage: Uint8Array;
}

export function noteFromSecrets(nullifier: bigint, secret: bigint): Note {
  const nullifierBytes = numberToBytesLE(nullifier, 31);
  const preimage = concatBytes(nullifierBytes, numberToBytesLE(secret, 31));
  return {
    nullifier,
    secret,
    preimage,
    commitment: pedersenHash(preimage),
    nullifierHash: pedersenHash(nullifierBytes),
  };
}

/** Fresh random note (31-byte nullifier and secret, as tornado-cli does). */
export function createNote(): Note {
  return noteFromSecrets(bytesToNumberLE(randomBytes(31)), bytesToNumberLE(randomBytes(31)));
}

/** Classic note string: tornado-eth-0.1-1-0x<62 bytes>. */
export function toNoteString(note: Note, currency: string, amount: string, chainId: number | bigint): string {
  return `tornado-${currency}-${amount}-${chainId}-${toHex(note.preimage)}`;
}

const NOTE_REGEX = /^tornado-([a-zA-Z0-9]+)-([0-9.]+)-(\d+)-0x([0-9a-fA-F]{124})$/;

export function parseNoteString(noteString: string): Note & { currency: string; amount: string; chainId: bigint } {
  const m = NOTE_REGEX.exec(noteString.trim());
  if (!m) throw new Error(`invalid tornado note: ${noteString}`);
  const [, currency, amount, chainId, hex] = m as unknown as [string, string, string, string, string];
  const preimage = hexToBytes(hex);
  const note = noteFromSecrets(bytesToNumberLE(preimage.subarray(0, 31)), bytesToNumberLE(preimage.subarray(31, 62)));
  return { ...note, currency, amount, chainId: BigInt(chainId) };
}

export const commitmentHex = (note: Note): Hex => toHex(note.commitment, { size: 32 });
export const nullifierHashHex = (note: Note): Hex => toHex(note.nullifierHash, { size: 32 });
