import { mimcSpongecontract } from 'circomlibjs';
import type { Abi, Hex } from 'viem';

/**
 * Bytecode of the MiMC sponge hasher every Tornado instance is linked to
 * (circomlib `mimcsponge`, 220 rounds). Deterministic, so a fresh deployment on
 * a fork hashes identically to the canonical mainnet/sepolia hashers.
 */
export function mimcHasherBytecode(): Hex {
  return mimcSpongecontract.createCode('mimcsponge', 220) as Hex;
}

export const mimcHasherAbi = mimcSpongecontract.abi as Abi;
