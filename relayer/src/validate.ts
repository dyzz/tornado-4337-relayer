import { decodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { baseAccountAbi, paymasterAbi, tornadoInstanceAbi } from './abi.js';

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
  /** `paymaster`: `TornadoRelayerPaymaster.relayWithdraw` (Router / registry path); `direct`: `pool.withdraw`. */
  via: 'paymaster' | 'direct';
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

/**
 * Decode every Tornado withdraw among the account's calls: direct `pool.withdraw`
 * calls (any target) and `relayWithdraw` calls to `paymaster`.
 */
export function decodeTornadoWithdraws(calls: DecodedCall[], paymaster?: Address): TornadoWithdrawCall[] {
  const matches: TornadoWithdrawCall[] = [];
  calls.forEach((call, index) => {
    if (paymaster && isAddressEqual(call.target, paymaster)) {
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: paymasterAbi, data: call.data });
      } catch {
        return;
      }
      if (decoded.functionName !== 'relayWithdraw') return;
      const [pool, proof, root, nullifierHash, recipient, relayer, fee] = decoded.args;
      matches.push({
        index,
        instance: getAddress(pool),
        proof,
        root,
        nullifierHash,
        recipient: getAddress(recipient),
        relayer: getAddress(relayer),
        fee,
        refund: 0n,
        via: 'paymaster',
      });
      return;
    }
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
      via: 'direct',
    });
  });
  return matches;
}

export interface SponsorRules {
  /** TornadoRelayerPaymaster address: the sponsoring call must be `relayWithdraw` on it. */
  paymaster: Address;
  /** Address the proof must name as `relayer` (the paymaster in master mode, the master EOA in worker mode). */
  rewardAccount: Address;
  allowedInstances: Address[];
  /** userOp.sender: `relayWithdraw` only accepts the note's recipient as caller. */
  sender: Address;
}

/**
 * Find the withdraw that pays for this userOp: the one `relayWithdraw` on the paymaster, naming
 * `rewardAccount` as relayer and the sender as recipient, so the DAO's Router / RelayerRegistry sees
 * the paymaster as the relayer and burns the stake once per relayed withdrawal, as today.
 *
 * What this guarantees, precisely: the one `relayWithdraw` this sponsorship authorises must go through the
 * Router and follows the DAO's existing fee rules. Among the operation's own (top-level) calls a second
 * Tornado withdrawal is refused, and nothing but `relayWithdraw` may touch the paymaster.
 *
 * What it does not cover: anything a tail-call contract does internally. These are the account's
 * top-level calls only; the decoder does not walk the call tree, so it makes no statement about other
 * withdrawals or calls made inside a tail call — whether they go through the Router, pay a relayer or
 * burn TORN. Multi-note withdrawals are separate UserOperations (the Kohaku SDK issues one per note);
 * atomicity holds within each operation, not across them.
 */
export function findSponsoringWithdraw(calls: DecodedCall[], rules: SponsorRules): TornadoWithdrawCall {
  const withdraws = decodeTornadoWithdraws(calls, rules.paymaster);
  if (withdraws.length === 0) throw new ValidationError('callData contains no Tornado withdraw');

  const paymasterCalls = calls.filter((c) => isAddressEqual(c.target, rules.paymaster));
  const relayed = withdraws.filter((w) => w.via === 'paymaster');
  if (paymasterCalls.length !== relayed.length) {
    throw new ValidationError('only relayWithdraw may be called on the paymaster');
  }
  if (relayed.length === 0) {
    throw new ValidationError(`no relayWithdraw call on the paymaster ${rules.paymaster}`);
  }
  if (withdraws.length > 1) {
    throw new ValidationError('one Tornado withdrawal per operation: every relayed note must go through the router');
  }
  const w = relayed[0]!;
  if (!isAddressEqual(w.relayer, rules.rewardAccount)) {
    throw new ValidationError(`relayWithdraw must name ${rules.rewardAccount} as relayer, got ${w.relayer}`);
  }
  if (!isAddressEqual(w.recipient, rules.sender)) {
    throw new ValidationError(`relayWithdraw recipient must be the userOp sender ${rules.sender}, got ${w.recipient}`);
  }
  if (!rules.allowedInstances.some((a) => isAddressEqual(a, w.instance))) {
    throw new ValidationError(`instance ${w.instance} is not served by this relayer`);
  }
  const call = calls[w.index]!;
  if (call.value !== 0n) throw new ValidationError('relayWithdraw call must not carry value');
  return w;
}
