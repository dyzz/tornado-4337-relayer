import {
  encodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  createBundlerClient,
  createPaymasterClient,
  toSimple7702SmartAccount,
  type UserOperationReceipt,
} from 'viem/account-abstraction';

import { tornadoAbi } from './abi.js';
import { merklePath } from './merkle.js';
import type { Note } from './note.js';
import type { TornadoProveOutput, TornadoProver } from './prover.js';
import { RelayerRpc, type RelayerQuote } from './relayerClient.js';

export interface TailCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

export interface SponsoredWithdrawParams {
  publicClient: PublicClient;
  chain: Chain;
  bundlerUrl: string;
  relayerUrl: string;
  instance: Address;
  note: Note;
  /** All deposit commitments of the instance, ordered by leaf index. */
  leaves: (bigint | string)[];
  prover: TornadoProver;
  /**
   * Ephemeral EIP-7702 sender. It becomes the userOp sender and the Tornado
   * recipient, executes the tail calls, and signs the userOp — exactly the role
   * Kohaku's `paymasterWithdrawThunk` gives its delegator account.
   */
  owner: PrivateKeyAccount;
  /** Receives fee - actual gas - serviceFee after execution (postOp refund). */
  refundTo: Address;
  /**
   * Calls executed by the sender right after the withdraw. `amount = denomination - fee` in
   * the pool asset; `asset` is zeroAddress for ETH pools, else the ERC-20 the sender now holds.
   */
  tailCalls: (ctx: { sender: Address; amount: bigint; asset: Address }) => TailCall[];
  /** callGasLimit budget for the tail calls used for the initial quote. */
  tailCallsGas?: bigint;
  /** Simple7702Account implementation (defaults to the canonical v0.8 deployment). */
  implementation?: Address;
  /** Skip the bundler estimation round-trip and send with the quoted ceilings. */
  skipEstimation?: boolean;
  log?: (msg: string) => void;
}

export interface SponsoredWithdrawResult {
  userOpHash: Hex;
  receipt: UserOperationReceipt;
  sender: Address;
  quote: RelayerQuote;
  proof: TornadoProveOutput;
  fee: bigint;
  amountToSender: bigint;
}

const bump = (x: bigint, bps: bigint) => (x * (10_000n + bps)) / 10_000n;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Withdraw a Tornado note through the thin relayer + paymaster over ERC-4337 and
 * run arbitrary tail calls in the same atomic userOp.
 *
 *   1. tornado_quote           -> fee the proof must bind (relayer = paymaster)
 *   2. prove                    -> groth16 proof for (sender, paymaster, fee)
 *   3. eth_estimateUserOperationGas (stub paymasterData, no signature yet)
 *   4. re-quote at the estimated gas; re-prove only if the fee changed
 *   5. sendUserOperation        -> viem asks the relayer for pm_getPaymasterData
 *                                  (ERC-7677), signs with the sender key, and
 *                                  hands the op to the bundler
 */
export async function sponsoredWithdraw(p: SponsoredWithdrawParams): Promise<SponsoredWithdrawResult> {
  const log = p.log ?? (() => {});
  const relayer = new RelayerRpc(p.relayerUrl);
  const paymasterClient = createPaymasterClient({ transport: http(p.relayerUrl) });
  const account = await toSimple7702SmartAccount({
    client: p.publicClient,
    owner: p.owner,
    implementation: p.implementation,
  });
  const bundler = createBundlerClient({
    account,
    client: p.publicClient,
    chain: p.chain,
    transport: http(p.bundlerUrl),
    paymasterContext: { refundTo: p.refundTo },
  });

  const denomination = await p.publicClient.readContract({
    address: p.instance,
    abi: tornadoAbi,
    functionName: 'denomination',
  });
  const path = merklePath(p.leaves, p.note.commitment);
  const rootHex = `0x${path.root.toString(16).padStart(64, '0')}` as Hex;
  const known = await p.publicClient.readContract({
    address: p.instance,
    abi: tornadoAbi,
    functionName: 'isKnownRoot',
    args: [rootHex],
  });
  if (!known) throw new Error('local merkle root is not known to the instance; leaves are stale or wrong');

  const prove = (relayerAddress: Address, fee: bigint) =>
    p.prover.prove({
      nullifier: p.note.nullifier,
      secret: p.note.secret,
      pathElements: path.pathElements,
      pathIndices: path.pathIndices,
      root: path.root,
      nullifierHash: p.note.nullifierHash,
      recipient: BigInt(account.address),
      relayer: BigInt(relayerAddress),
      fee,
      refund: 0n,
    });

  const buildCalls = (proof: TornadoProveOutput, fee: bigint, asset: Address) => {
    const [root, nullifierHash, recipient, relayerArg, feeArg, refundArg] = proof.args;
    const withdraw: TailCall = {
      to: p.instance,
      value: 0n,
      data: encodeFunctionData({
        abi: tornadoAbi,
        functionName: 'withdraw',
        args: [proof.proof, root, nullifierHash, recipient, relayerArg, BigInt(feeArg), BigInt(refundArg)],
      }),
    };
    return [withdraw, ...p.tailCalls({ sender: account.address, amount: denomination - fee, asset })];
  };

  // 1-2. Quote at conservative ceilings and prove against that fee.
  let quote = await relayer.quote({ instance: p.instance, tailCallsGas: p.tailCallsGas });
  const asset = quote.feeToken;
  log(
    `quote: fee=${quote.fee} ${quote.symbol} (service ${quote.serviceFee}) at ${quote.maxFeePerGas} wei/gas` +
      (quote.tokenPerEth ? `, rate ${quote.tokenPerEth} ${quote.symbol}-units/ETH` : '') +
      `, relayer=${quote.relayer}`,
  );
  let proof = await prove(quote.relayer, quote.fee);
  log(`proof ready, sender=${account.address}`);

  // 3-4. Let the bundler size the op. Only the stub role is wired so nothing is signed yet.
  if (!p.skipEstimation) {
    const est = await bundler.estimateUserOperationGas({
      calls: buildCalls(proof, quote.fee, asset),
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      paymaster: { getPaymasterData: (args) => paymasterClient.getPaymasterStubData(args) },
    });
    const gas = {
      callGasLimit: bump(est.callGasLimit, 1_500n),
      verificationGasLimit: bump(est.verificationGasLimit, 1_500n),
      preVerificationGas: bump(est.preVerificationGas, 1_000n),
      paymasterVerificationGasLimit: max(bump(est.paymasterVerificationGasLimit ?? 0n, 1_500n), quote.gas.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: max(bump(est.paymasterPostOpGasLimit ?? 0n, 2_000n), quote.gas.paymasterPostOpGasLimit),
    };
    const requote = await relayer.quote({ instance: p.instance, gas, maxFeePerGas: quote.maxFeePerGas });
    log(`estimated gas: call=${est.callGasLimit} verif=${est.verificationGasLimit} pvg=${est.preVerificationGas}; re-quoted fee=${requote.fee}`);
    if (requote.fee !== quote.fee) {
      proof = await prove(requote.relayer, requote.fee);
      log('re-proved at the estimated fee');
    }
    quote = requote;
  }

  // 5. Sign the EIP-7702 delegation (fresh EOA -> Simple7702Account) unless already delegated.
  const authorization = (await account.isDeployed())
    ? undefined
    : await p.owner.signAuthorization({
        address: p.implementation ?? account.authorization!.address,
        chainId: p.chain.id,
        nonce: await p.publicClient.getTransactionCount({ address: p.owner.address }),
      });

  // 6. Send. viem: pm_getPaymasterStubData -> pm_getPaymasterData (relayer signs) -> sender signs -> bundler.
  const userOpHash = await bundler.sendUserOperation({
    calls: buildCalls(proof, quote.fee, asset),
    ...quote.gas,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    paymaster: paymasterClient,
    ...(authorization ? { authorization } : {}),
  });
  log(`userOp sent: ${userOpHash}`);
  const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 });
  log(`userOp mined in tx ${receipt.receipt.transactionHash}, success=${receipt.success}`);

  return {
    userOpHash,
    receipt,
    sender: account.address,
    quote,
    proof,
    fee: quote.fee,
    amountToSender: denomination - quote.fee,
  };
}
