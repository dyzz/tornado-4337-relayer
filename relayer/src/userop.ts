import {
  concatHex,
  encodeAbiParameters,
  encodePacked,
  hexToBigInt,
  isHex,
  keccak256,
  pad,
  toHex,
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

export interface FeeTerms {
  validUntil: number;
  validAfter: number;
  fee: bigint;
  serviceFee: bigint;
  refundTo: Address;
}

export const PAYMASTER_DATA_OFFSET = 52;
export const PAYMASTER_AND_DATA_LENGTH = 213;
export const SIGNATURE_LENGTH = 65;

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

/** viem-compatible initCode packing (factory `0x7702` marks an EIP-7702 sender). */
export function packInitCode(op: RpcUserOperation): Hex {
  if (op.initCode !== undefined) return op.initCode;
  if (!op.factory) return '0x';
  if (op.factory === '0x7702') return concatHex(['0x7702', op.factoryData ?? '0x']);
  return concatHex([op.factory, op.factoryData ?? '0x']);
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
 * The 161-byte suffix of paymasterAndData understood by TornadoRelayerPaymaster:
 * validUntil(6) | validAfter(6) | fee(32) | serviceFee(32) | refundTo(20) | signature(65).
 */
export function encodePaymasterData(terms: FeeTerms, signature: Hex): Hex {
  if ((signature.length - 2) / 2 !== SIGNATURE_LENGTH) throw new Error('signature must be 65 bytes');
  return encodePacked(
    ['uint48', 'uint48', 'uint256', 'uint256', 'address', 'bytes'],
    [terms.validUntil, terms.validAfter, terms.fee, terms.serviceFee, terms.refundTo, signature],
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
        keccak256(packInitCode(op)),
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
      ],
      [fieldsHash, chainId, paymaster, terms.validUntil, terms.validAfter, terms.fee, terms.serviceFee, terms.refundTo],
    ),
  );
}
