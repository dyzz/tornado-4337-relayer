import {
  custom,
  encodeFunctionData,
  http,
  RpcRequestError,
  toHex,
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

import { delegationCode } from '@tornado-4337/relayer';
import { paymasterAdminAbi, tornadoAbi } from './abi.js';
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

/**
 * A bundler transport that sends the ERC-4337 request in its canonical shape:
 *  - viem formats the EIP-7702 authorization's `yParity` as a zero-padded byte (`0x00`/`0x01`); bundlers
 *    that hand the tuple straight to the node (eth-infinitism) then trip geth's strict QUANTITY parsing
 *    ("hex number with leading zero digits"). Quantities go out minimal.
 *  - viem sends `factory: "0x7702", factoryData: "0x"` for a not-yet-delegated sender; an empty
 *    factoryData is omitted (the reference bundler reads any present factoryData as an
 *    `initEip7702Sender` call and then mis-indexes the validation frames of the trace).
 */
function strictHexTransport(url: string) {
  const quantity = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? toHex(BigInt(v)) : v);
  const canonical = (params: unknown): unknown => {
    if (!Array.isArray(params)) return params;
    return params.map((param) => {
      if (!param || typeof param !== 'object') return param;
      const op = { ...(param as Record<string, unknown>) };
      if (op.factory === '0x7702' && (op.factoryData === '0x' || op.factoryData === undefined)) delete op.factoryData;
      const auth = op.eip7702Auth as Record<string, unknown> | undefined;
      if (auth) op.eip7702Auth = { ...auth, chainId: quantity(auth.chainId), nonce: quantity(auth.nonce), yParity: quantity(auth.yParity) };
      return op;
    });
  };
  let id = 0;
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const body = { jsonrpc: '2.0', id: ++id, method, params: canonical(params) };
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (json.error) throw new RpcRequestError({ body, error: json.error, url });
      return json.result;
    },
  });
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
 *   1. tornado_quote           -> fee the proof must bind and the relayer address to name
 *                                  (the paymaster, or an existing relayer's master in worker mode)
 *   2. prove                    -> groth16 proof for (sender, relayer, fee)
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
    transport: strictHexTransport(p.bundlerUrl),
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

  // The sponsoring withdraw goes through `paymaster.relayWithdraw`, which forwards it to the
  // DAO's TornadoRouter (RelayerRegistry burn) — or straight to the pool on chains without one.
  const buildCalls = (proof: TornadoProveOutput, fee: bigint, asset: Address, paymaster: Address) => {
    const [root, nullifierHash, recipient, relayerArg, feeArg] = proof.args;
    const withdraw: TailCall = {
      to: paymaster,
      value: 0n,
      data: encodeFunctionData({
        abi: paymasterAdminAbi,
        functionName: 'relayWithdraw',
        args: [p.instance, proof.proof, root, nullifierHash, recipient, relayerArg, BigInt(feeArg)],
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
      `, relayer=${quote.relayer} via paymaster ${quote.paymaster}`,
  );
  let proof = await prove(quote.relayer, quote.fee);
  log(`proof ready, sender=${account.address}`);

  const implementation = p.implementation ?? account.authorization!.address;
  const delegated = await account.isDeployed();

  // 3-4. Let the bundler size the op. Only the stub role is wired so nothing is signed yet.
  if (!p.skipEstimation) {
    const est = await bundler.estimateUserOperationGas({
      calls: buildCalls(proof, quote.fee, asset, quote.paymaster),
      // The quoted ceilings as the starting point: strict bundlers (eth-infinitism) require every gas
      // field to be present in eth_estimateUserOperationGas; alto ignores them.
      ...quote.gas,
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      paymaster: { getPaymasterData: (args) => paymasterClient.getPaymasterStubData(args) },
      // A not-yet-delegated sender has no code for the estimation call: simulate it as already
      // delegated (the in-op authorization is only applied when the bundle is mined).
      ...(delegated ? {} : { stateOverride: [{ address: p.owner.address, code: delegationCode(implementation) }] }),
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
  const authorization = delegated
    ? undefined
    : await p.owner.signAuthorization({
        address: implementation,
        chainId: p.chain.id,
        nonce: await p.publicClient.getTransactionCount({ address: p.owner.address }),
      });

  // 6. Send. viem: pm_getPaymasterStubData -> pm_getPaymasterData (relayer signs) -> sender signs -> bundler.
  const userOpHash = await bundler.sendUserOperation({
    calls: buildCalls(proof, quote.fee, asset, quote.paymaster),
    ...quote.gas,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    paymaster: paymasterClient,
    ...(authorization ? { authorization } : {}),
    // viem re-estimates inside prepareUserOperation when the paymaster stub leaves a gas field open;
    // give that estimate the same delegated-sender view (see step 3-4).
    ...(delegated ? {} : { stateOverride: [{ address: p.owner.address, code: delegationCode(implementation) }] }),
  } as Parameters<typeof bundler.sendUserOperation>[0]);
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
