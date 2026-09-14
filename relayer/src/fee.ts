import { RATE_SCALE, totalGas, type UserOpGas } from './userop.js';

export const BPS = 10_000n;

/**
 * Conservative execution budgets for a sponsored withdrawal. The relayer quotes
 * against these ceilings; the paymaster refunds whatever the op does not
 * actually burn, so over-provisioning costs the user nothing but float.
 */
export const DEFAULT_GAS: UserOpGas = {
  // Simple7702Account signature check + EntryPoint bookkeeping.
  verificationGasLimit: 100_000n,
  // pool.withdraw (groth16 verify + merkle path, ~350k; ERC-20 instances add two transfers).
  callGasLimit: 450_000n,
  // Calldata (proof is 256 bytes) + EIP-7702 authorization overhead.
  preVerificationGas: 120_000n,
  // Signature recovery only.
  paymasterVerificationGasLimit: 60_000n,
  // Refund transfer + EntryPoint depositTo (or token transfer) + event.
  paymasterPostOpGasLimit: 90_000n,
};

/** Extra callGasLimit for the two ERC-20 transfers an ERC20Tornado withdraw performs. */
export const ERC20_WITHDRAW_EXTRA_GAS = 80_000n;

/** Extra callGasLimit assumed for tail calls when the client gives no estimate. */
export const DEFAULT_TAIL_CALLS_GAS = 400_000n;

export function withTailCalls(gas: UserOpGas, tailCallsGas: bigint): UserOpGas {
  return { ...gas, callGasLimit: gas.callGasLimit + tailCallsGas };
}

export function serviceFeeFor(denomination: bigint, serviceFeeBps: bigint): bigint {
  return (denomination * serviceFeeBps) / BPS;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Minimum `fee` the relayer accepts for a userOp, in the instance's fee token:
 * the EntryPoint prefund (gas * maxFeePerGas) plus the paymaster's margin —
 * converted at `tokenPerEth` for ERC-20 instances — plus the service fee. This
 * is exactly the worst case the paymaster can be charged; the difference to the
 * actual cost is refunded in postOp (at the same signed rate).
 */
export function minimumFee(params: {
  gas: UserOpGas;
  maxFeePerGas: bigint;
  gasMarginBps: bigint;
  serviceFee: bigint;
  /** feeToken units per 1e18 wei; omit / 0 for ETH instances. */
  tokenPerEth?: bigint;
}): bigint {
  const prefund = totalGas(params.gas) * params.maxFeePerGas;
  const keepEth = prefund + (prefund * params.gasMarginBps) / BPS;
  const keep = params.tokenPerEth ? ceilDiv(keepEth * params.tokenPerEth, RATE_SCALE) : keepEth;
  return keep + params.serviceFee;
}
