import { totalGas, type UserOpGas } from './userop.js';

export const BPS = 10_000n;

/**
 * Conservative execution budgets for a sponsored ETH withdrawal. The relayer
 * quotes against these ceilings; the paymaster refunds whatever the op does not
 * actually burn, so over-provisioning costs the user nothing but float.
 */
export const DEFAULT_GAS: UserOpGas = {
  // Simple7702Account signature check + EntryPoint bookkeeping.
  verificationGasLimit: 100_000n,
  // pool.withdraw (groth16 verify + merkle path, ~350k) plus generous tail-call room.
  callGasLimit: 450_000n,
  // Calldata (proof is 256 bytes) + EIP-7702 authorization overhead.
  preVerificationGas: 120_000n,
  // Signature recovery only.
  paymasterVerificationGasLimit: 60_000n,
  // Refund transfer + EntryPoint depositTo + event.
  paymasterPostOpGasLimit: 90_000n,
};

/** Extra callGasLimit assumed for tail calls when the client gives no estimate. */
export const DEFAULT_TAIL_CALLS_GAS = 400_000n;

export function withTailCalls(gas: UserOpGas, tailCallsGas: bigint): UserOpGas {
  return { ...gas, callGasLimit: gas.callGasLimit + tailCallsGas };
}

export function serviceFeeFor(denomination: bigint, serviceFeeBps: bigint): bigint {
  return (denomination * serviceFeeBps) / BPS;
}

/**
 * Minimum `fee` the relayer accepts for a userOp: the EntryPoint prefund
 * (gas * maxFeePerGas) plus the paymaster's margin plus the service fee. This is
 * exactly the worst case the paymaster can be charged; the difference to the
 * actual cost is refunded in postOp.
 */
export function minimumFee(params: {
  gas: UserOpGas;
  maxFeePerGas: bigint;
  gasMarginBps: bigint;
  serviceFee: bigint;
}): bigint {
  const prefund = totalGas(params.gas) * params.maxFeePerGas;
  return prefund + (prefund * params.gasMarginBps) / BPS + params.serviceFee;
}
