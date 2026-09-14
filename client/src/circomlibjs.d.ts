declare module 'circomlibjs' {
  export const mimcSpongecontract: {
    abi: unknown[];
    createCode(seed: string, nRounds: number): string;
  };
  export function buildMimcSponge(): Promise<{
    F: { toObject(x: unknown): bigint };
    hash(xL: bigint, xR: bigint, k: bigint): { xL: unknown; xR: unknown };
  }>;
}
