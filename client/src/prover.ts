/**
 * Groth16 prover for the Tornado Cash `withdraw` circuit, running on
 * `micro-zk-proofs` with the original websnark artifacts (tornado.json +
 * tornadoProvingKey.bin). Adapted from `@kohaku-eth/tornado-cash`
 * (packages/tornado-cash/src/utils/tornado-prover.ts, MIT, Ethereum Foundation)
 * so this client produces proofs bit-for-bit compatible with what Kohaku emits.
 */
import * as zkp from 'micro-zk-proofs';
import { bn254 } from '@noble/curves/bn254.js';
import * as zkpWitness from 'micro-zk-proofs/witness.js';
import * as zkpMsm from 'micro-zk-proofs/msm.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { toHex, type Hex } from 'viem';

export interface TornadoWithdrawInputs {
  nullifier: bigint;
  secret: bigint;
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
  nullifierHash: bigint;
  recipient: bigint;
  relayer: bigint;
  fee: bigint;
  refund: bigint;
}

/** Solidity-ready output: packed proof plus the six public inputs as hex words. */
export interface TornadoProveOutput {
  proof: Hex;
  args: [Hex, Hex, Hex, Hex, Hex, Hex]; // root, nullifierHash, recipient, relayer, fee, refund
}

export interface TornadoProver {
  prove(inputs: TornadoWithdrawInputs): Promise<TornadoProveOutput>;
}

const Fp = bn254.fields.Fp;
const Fr = bn254.fields.Fr;
const FP_R_INV = Fp.inv(2n ** 256n % Fp.ORDER);
const FR_R_INV = Fr.inv(2n ** 256n % Fr.ORDER);
const fromMontgomeryFp = (x: bigint): bigint => Fp.mul(x, FP_R_INV);
const fromMontgomeryFr = (x: bigint): bigint => Fr.mul(x, FR_R_INV);

function readG1(bytes: Uint8Array, offset: number): zkp.G1Point | null {
  const x = fromMontgomeryFp(bytesToNumberLE(bytes.subarray(offset, offset + 32)));
  const y = fromMontgomeryFp(bytesToNumberLE(bytes.subarray(offset + 32, offset + 64)));
  if (x === 0n && y === 1n) return null;
  return [x, y, 1n];
}

function readG2(bytes: Uint8Array, offset: number): zkp.G2Point | null {
  const x0 = fromMontgomeryFp(bytesToNumberLE(bytes.subarray(offset, offset + 32)));
  const x1 = fromMontgomeryFp(bytesToNumberLE(bytes.subarray(offset + 32, offset + 64)));
  const y0 = fromMontgomeryFp(bytesToNumberLE(bytes.subarray(offset + 64, offset + 96)));
  const y1 = fromMontgomeryFp(bytesToNumberLE(bytes.subarray(offset + 96, offset + 128)));
  if (x0 === 0n && x1 === 0n && y0 === 1n && y1 === 0n) return null;
  return [
    [x0, x1],
    [y0, y1],
    [1n, 0n],
  ];
}

function parseProvingKey(pkeyBuf: ArrayBuffer): zkp.ProvingKey {
  const dv = new DataView(pkeyBuf);
  const bytes = new Uint8Array(pkeyBuf);

  const nVars = dv.getUint32(0, true);
  const nPublic = dv.getUint32(4, true);
  const domainSize = dv.getUint32(8, true);
  const pPolsA = dv.getUint32(12, true);
  const pPolsB = dv.getUint32(16, true);
  const pPointsA = dv.getUint32(20, true);
  const pPointsB1 = dv.getUint32(24, true);
  const pPointsB2 = dv.getUint32(28, true);
  const pPointsC = dv.getUint32(32, true);
  const pHExps = dv.getUint32(36, true);

  const FIXED = 40;
  const vk_alfa_1 = readG1(bytes, FIXED) as zkp.G1Point;
  const vk_beta_1 = readG1(bytes, FIXED + 64) as zkp.G1Point;
  const vk_delta_1 = readG1(bytes, FIXED + 128) as zkp.G1Point;
  const vk_beta_2 = readG2(bytes, FIXED + 192) as zkp.G2Point;
  const vk_delta_2 = readG2(bytes, FIXED + 320) as zkp.G2Point;

  const parsePols = (startOffset: number): zkp.Constraint[] => {
    const pols: zkp.Constraint[] = [];
    let off = startOffset;
    for (let s = 0; s < nVars; s++) {
      const pol: zkp.Constraint = {};
      const numEntries = dv.getUint32(off, true);
      off += 4;
      for (let j = 0; j < numEntries; j++) {
        const cIdx = dv.getUint32(off, true);
        off += 4;
        const coeff = fromMontgomeryFr(bytesToNumberLE(bytes.subarray(off, off + 32)));
        off += 32;
        if (coeff !== 0n) pol[cIdx] = coeff;
      }
      pols.push(pol);
    }
    return pols;
  };

  const polsA = parsePols(pPolsA);
  const polsB = parsePols(pPolsB);
  // polsC is not stored in the binary key; the h-polynomial slice does not depend on it.
  const polsC: zkp.Constraint[] = Array.from({ length: nVars }, () => ({}));

  const readG1s = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => readG1(bytes, offset + i * 64)) as unknown as zkp.G1Point[];
  const readG2s = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => readG2(bytes, offset + i * 128)) as unknown as zkp.G2Point[];

  const A = readG1s(pPointsA, nVars);
  const B1 = readG1s(pPointsB1, nVars);
  const B2 = readG2s(pPointsB2, nVars);
  const hExps = readG1s(pHExps, domainSize - 1);
  const rawC = readG1s(pPointsC, nVars - nPublic - 1);
  const C = [...new Array(nPublic + 1).fill(null), ...rawC] as unknown as zkp.G1Point[];

  return {
    nVars,
    nPublic,
    domainBits: Math.log2(domainSize),
    domainSize,
    polsA,
    polsB,
    polsC,
    A,
    B1,
    B2,
    C,
    hExps,
    vk_alfa_1,
    vk_beta_1,
    vk_delta_1,
    vk_beta_2,
    vk_delta_2,
  };
}

function toSolidityInput({ proof }: zkp.ProofWithSignals): Hex {
  // Verifier.sol reads G2 coordinates as [real, imaginary]; noble stores [imag, real].
  const flat = zkp.stringBigints.decode([
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
    proof.pi_c[0],
    proof.pi_c[1],
  ]);
  return ('0x' + flat.map((x) => x.toString(16).padStart(64, '0')).join('')) as Hex;
}

/**
 * @param circuit   parsed `tornado.json`
 * @param provingKey raw `tornadoProvingKey.bin`
 */
export async function createTornadoProver(circuit: object, provingKey: ArrayBuffer): Promise<TornadoProver> {
  const msm = zkpMsm.initMSM();
  // The websnark proving key was generated with NQR = 7; noble defaults to 5.
  const { groth } = zkp.buildSnark(bn254, {
    nqr: 7,
    G1msm: msm.methods.bn254_msmG1,
    G2msm: msm.methods.bn254_msmG2,
  });
  const pkey = parseProvingKey(provingKey);

  return {
    async prove(inputs) {
      const witness = zkpWitness.generateWitness(circuit)(inputs);
      const proofJs = await groth.createProof(pkey, witness);
      return {
        proof: toSolidityInput(proofJs),
        args: [
          toHex(inputs.root, { size: 32 }),
          toHex(inputs.nullifierHash, { size: 32 }),
          toHex(inputs.recipient, { size: 20 }),
          toHex(inputs.relayer, { size: 20 }),
          toHex(inputs.fee, { size: 32 }),
          toHex(inputs.refund, { size: 32 }),
        ],
      };
    },
  };
}
