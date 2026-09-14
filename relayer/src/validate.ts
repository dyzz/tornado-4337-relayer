import { decodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { baseAccountAbi, tornadoInstanceAbi } from './abi.js';

export interface DecodedCall {
  target: Address;
  value: bigint;
  data: Hex;
}

export interface TornadoWithdrawCall {
  index: number;
  instance: Address;
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  recipient: Address;
  relayer: Address;
  fee: bigint;
  refund: bigint;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code = -32001,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Decode BaseAccount.execute / executeBatch callData into a flat call list. */
export function decodeAccountCalls(callData: Hex): DecodedCall[] {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: baseAccountAbi, data: callData });
  } catch {
    throw new ValidationError('callData is not BaseAccount.execute/executeBatch');
  }
  if (decoded.functionName === 'execute') {
    const [target, value, data] = decoded.args;
    return [{ target, value, data }];
  }
  return decoded.args[0].map((c) => ({ target: c.target, value: c.value, data: c.data }));
}

/** Decode every Tornado withdraw among the account's calls (any instance). */
export function decodeTornadoWithdraws(calls: DecodedCall[]): TornadoWithdrawCall[] {
  const matches: TornadoWithdrawCall[] = [];
  calls.forEach((call, index) => {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: tornadoInstanceAbi, data: call.data });
    } catch {
      return;
    }
    if (decoded.functionName !== 'withdraw') return;
    const [proof, root, nullifierHash, recipient, relayer, fee, refund] = decoded.args;
    matches.push({
      index,
      instance: getAddress(call.target),
      proof,
      root,
      nullifierHash,
      recipient: getAddress(recipient),
      relayer: getAddress(relayer),
      fee,
      refund,
    });
  });
  return matches;
}

/**
 * Find the withdraw that pays this paymaster. A batch may carry further
 * withdraws (Kohaku consolidates several notes into one userOp, the extra ones
 * with relayer = 0 and fee = 0); exactly one must name the paymaster as relayer.
 */
export function findSponsoringWithdraw(
  calls: DecodedCall[],
  paymaster: Address,
  allowedInstances: Address[],
): TornadoWithdrawCall {
  const withdraws = decodeTornadoWithdraws(calls);
  if (withdraws.length === 0) throw new ValidationError('callData contains no Tornado withdraw');
  const paying = withdraws.filter((w) => isAddressEqual(w.relayer, paymaster));
  if (paying.length === 0) {
    throw new ValidationError(`no withdraw names the paymaster ${paymaster} as relayer`);
  }
  if (paying.length > 1) throw new ValidationError('more than one withdraw pays the paymaster');
  const w = paying[0]!;
  if (!allowedInstances.some((a) => isAddressEqual(a, w.instance))) {
    throw new ValidationError(`instance ${w.instance} is not served by this relayer`);
  }
  const call = calls[w.index]!;
  if (call.value !== 0n) throw new ValidationError('withdraw call must not carry value on an ETH instance');
  if (w.refund !== 0n) throw new ValidationError('refund must be 0 on an ETH instance');
  return w;
}
