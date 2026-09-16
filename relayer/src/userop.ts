import {
  concatHex,
  encodeAbiParameters,
  encodePacked,
  hexToBigInt,
  isHex,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';

/**
 * ERC-7677 / EntryPoint v0.7+ "unpacked" userOp as it travels over JSON-RPC.
 * Every quantity is a hex string. `eip7702Auth` is the Pimlico/alto extension
 * for EIP-7702 senders and is forwarded verbatim to the bundler when simulating.
 */
export interface RpcUserOperation {
  sender: Address;
  nonce: Hex;
  factory?: Address | '0x7702';
  factoryData?: Hex;
  /** v0.6-style alternative to factory/factoryData; honoured if present. */
  initCode?: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster?: Address;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
  paymasterData?: Hex;
  signature?: Hex;
  eip7702Auth?: {
    address: Address;
    chainId: Hex;
    nonce: Hex;
    r: Hex;
    s: Hex;
    yParity: Hex;
  };
}

export interface UserOpGas {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

/** The fee terms the relayer signs (mirrors TornadoRelayerPaymaster.Terms). */
export interface FeeTerms {
  validUntil: number;
  validAfter: number;
  /** In `feeToken` units (wei for ETH instances). */
  fee: bigint;
  serviceFee: bigint;
  refundTo: Address;
  /** address(0) for ETH instances. */
  feeToken: Address;
  /** feeToken base units per 1e18 wei; 0 for ETH. */
  tokenPerEth: bigint;
  /** `withdrawalHash(...)` of the one relayWithdraw call this sponsorship approves. */
  withdrawalHash: Hex;
  /** EIP-7702 implementation the sender must be delegated to when the op is validated (zero = not enforced). */
  senderImplementation: Address;
}

export const PAYMASTER_DATA_OFFSET = 52;
export const PAYMASTER_AND_DATA_LENGTH = 317;
export const SIGNATURE_LENGTH = 65;
export const RATE_SCALE = 10n ** 18n;

/** A syntactically valid but unauthorised signature (r = s = 1, v = 27) for stubs. */
export const DUMMY_SIGNATURE: Hex = concatHex([
  pad('0x01', { size: 32 }),
  pad('0x01', { size: 32 }),
  '0x1b',
]);

export function q(value: Hex | undefined, field: string): bigint {
  if (value === undefined || !isHex(value)) throw new Error(`userOp.${field} must be a hex quantity`);
  return hexToBigInt(value);
}

export function packHighLow(high: bigint, low: bigint): Hex {
  return concatHex([pad(toHex(high), { size: 16 }), pad(toHex(low), { size: 16 })]);
}

/** The EntryPoint's EIP-7702 initCode marker: `0x7702` in the first 20 bytes (padded with zeros). */
export const EIP7702_INITCODE_MARKER: Hex = `0x7702${'00'.repeat(18)}`;

/** initCode packing per EntryPoint v0.8 (factory `0x7702` marks an EIP-7702 sender: 20-byte marker ‖ factoryData). */
export function packInitCode(op: RpcUserOperation): Hex {
  if (op.initCode !== undefined) return op.initCode;
  if (!op.factory) return '0x';
  if (op.factory === '0x7702') return concatHex([EIP7702_INITCODE_MARKER, op.factoryData ?? '0x']);
  return concatHex([op.factory, op.factoryData ?? '0x']);
}

/** True for the EntryPoint's EIP-7702 marker, padded (`0x7702` + 18 zero bytes) or bare `0x7702`. */
export function isEip7702InitCode(initCode: Hex): boolean {
  const hex = initCode.toLowerCase();
  if (!hex.startsWith('0x7702')) return false;
  const head = hex.slice(2, 42).padEnd(40, '0');
  return head === EIP7702_INITCODE_MARKER.slice(2);
}

/**
 * `keccak256(initCode)` as the paymaster hashes it: for an EIP-7702 sender the EntryPoint hashes
 * `delegate ‖ initCode[20:]` instead of the marker bytes, and so do we — the relayer's signature must not
 * depend on how a bundler pads the marker.
 */
export function initCodeHash(op: RpcUserOperation, senderImplementation: Address | undefined): Hex {
  const initCode = packInitCode(op);
  if (!isEip7702InitCode(initCode)) return keccak256(initCode);
  if (!senderImplementation || senderImplementation === zeroAddress) {
    throw new Error('EIP-7702 initCode: the sender implementation is needed to hash the op');
  }
  const tail: Hex = initCode.length > 42 ? `0x${initCode.slice(42)}` : '0x';
  return keccak256(concatHex([senderImplementation, tail]));
}

export function readGas(op: RpcUserOperation): UserOpGas {
  return {
    callGasLimit: q(op.callGasLimit, 'callGasLimit'),
    verificationGasLimit: q(op.verificationGasLimit, 'verificationGasLimit'),
    preVerificationGas: q(op.preVerificationGas, 'preVerificationGas'),
    paymasterVerificationGasLimit: q(op.paymasterVerificationGasLimit ?? '0x0', 'paymasterVerificationGasLimit'),
    paymasterPostOpGasLimit: q(op.paymasterPostOpGasLimit ?? '0x0', 'paymasterPostOpGasLimit'),
  };
}

export function totalGas(gas: UserOpGas): bigint {
  return (
    gas.callGasLimit +
    gas.verificationGasLimit +
    gas.preVerificationGas +
    gas.paymasterVerificationGasLimit +
    gas.paymasterPostOpGasLimit
  );
}

/**
 * The 265-byte suffix of paymasterAndData understood by TornadoRelayerPaymaster:
 * validUntil(6) | validAfter(6) | fee(32) | serviceFee(32) | refundTo(20) | feeToken(20) | tokenPerEth(32) |
 * withdrawalHash(32) | senderImplementation(20) | signature(65).
 */
export function encodePaymasterData(terms: FeeTerms, signature: Hex): Hex {
  if ((signature.length - 2) / 2 !== SIGNATURE_LENGTH) throw new Error('signature must be 65 bytes');
  return encodePacked(
    ['uint48', 'uint48', 'uint256', 'uint256', 'address', 'address', 'uint256', 'bytes32', 'address', 'bytes'],
    [
      terms.validUntil,
      terms.validAfter,
      terms.fee,
      terms.serviceFee,
      terms.refundTo,
      terms.feeToken ?? zeroAddress,
      terms.tokenPerEth ?? 0n,
      terms.withdrawalHash,
      terms.senderImplementation ?? zeroAddress,
      signature,
    ],
  );
}

/** Mirrors TornadoRelayerPaymasterCore.withdrawalHash: identity of one relayWithdraw call. */
export function withdrawalHash(w: {
  instance: Address;
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  recipient: Address;
  relayer: Address;
  fee: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [w.instance, keccak256(w.proof), w.root, w.nullifierHash, w.recipient, w.relayer, w.fee],
    ),
  );
}

/**
 * Mirrors TornadoRelayerPaymaster.getHash. The relayer signs the EIP-191
 * personal-message digest of this value.
 */
export function paymasterHash(params: {
  op: RpcUserOperation;
  chainId: bigint;
  paymaster: Address;
  terms: FeeTerms;
}): Hex {
  const { op, chainId, paymaster, terms } = params;
  const gas = readGas(op);
  const accountGasLimits = packHighLow(gas.verificationGasLimit, gas.callGasLimit);
  const gasFees = packHighLow(q(op.maxPriorityFeePerGas, 'maxPriorityFeePerGas'), q(op.maxFeePerGas, 'maxFeePerGas'));
  const paymasterGasWord = hexToBigInt(packHighLow(gas.paymasterVerificationGasLimit, gas.paymasterPostOpGasLimit));

  const fieldsHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [
        op.sender,
        q(op.nonce, 'nonce'),
        initCodeHash(op, terms.senderImplementation),
        keccak256(op.callData),
        accountGasLimits,
        paymasterGasWord,
        gas.preVerificationGas,
        gasFees,
      ],
    ),
  );

  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint48' },
        { type: 'uint48' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
      ],
      [
        fieldsHash,
        chainId,
        paymaster,
        terms.validUntil,
        terms.validAfter,
        terms.fee,
        terms.serviceFee,
        terms.refundTo,
        terms.feeToken ?? zeroAddress,
        terms.tokenPerEth ?? 0n,
        terms.withdrawalHash,
        terms.senderImplementation ?? zeroAddress,
      ],
    ),
  );
}
