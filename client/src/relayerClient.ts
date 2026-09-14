import { hexToBigInt, toHex, type Address, type Hex } from 'viem';

export interface RelayerQuote {
  relayer: Address;
  entryPoint: Address;
  instance: Address;
  denomination: bigint;
  serviceFee: bigint;
  serviceFeeBps: bigint;
  gasMarginBps: bigint;
  gas: {
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    paymasterVerificationGasLimit: bigint;
    paymasterPostOpGasLimit: bigint;
  };
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  fee: bigint;
  validForSec: number;
}

export interface RelayerStatus {
  version: string;
  chainId: Hex;
  entryPoint: Address;
  paymaster: Address;
  rewardAccount: Address;
  signer: Address;
  instances: { address: Address; denomination: Hex }[];
  serviceFeeBps: Hex;
  gasMarginBps: Hex;
  signatureTtlSec: number;
  sponsor: { name: string };
}

/**
 * Minimal JSON-RPC client for the relayer's non-ERC-7677 methods. The ERC-7677
 * methods are consumed through viem's `createPaymasterClient`.
 */
export class RelayerRpc {
  constructor(readonly url: string) {}

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`relayer ${method}: ${body.error.message} (${body.error.code})`);
    return body.result as T;
  }

  status(): Promise<RelayerStatus> {
    return this.request('tornado_status');
  }

  async quote(params: {
    instance: Address;
    tailCallsGas?: bigint;
    gas?: Partial<RelayerQuote['gas']>;
    maxFeePerGas?: bigint;
  }): Promise<RelayerQuote> {
    const raw = await this.request<Record<string, unknown>>('tornado_quote', [
      {
        instance: params.instance,
        tailCallsGas: params.tailCallsGas !== undefined ? toHex(params.tailCallsGas) : undefined,
        gas: params.gas
          ? Object.fromEntries(Object.entries(params.gas).map(([k, v]) => [k, v === undefined ? undefined : toHex(v)]))
          : undefined,
        maxFeePerGas: params.maxFeePerGas !== undefined ? toHex(params.maxFeePerGas) : undefined,
      },
    ]);
    const gas = raw.gas as Record<string, Hex>;
    return {
      relayer: raw.relayer as Address,
      entryPoint: raw.entryPoint as Address,
      instance: raw.instance as Address,
      denomination: hexToBigInt(raw.denomination as Hex),
      serviceFee: hexToBigInt(raw.serviceFee as Hex),
      serviceFeeBps: hexToBigInt(raw.serviceFeeBps as Hex),
      gasMarginBps: hexToBigInt(raw.gasMarginBps as Hex),
      gas: {
        callGasLimit: hexToBigInt(gas.callGasLimit!),
        verificationGasLimit: hexToBigInt(gas.verificationGasLimit!),
        preVerificationGas: hexToBigInt(gas.preVerificationGas!),
        paymasterVerificationGasLimit: hexToBigInt(gas.paymasterVerificationGasLimit!),
        paymasterPostOpGasLimit: hexToBigInt(gas.paymasterPostOpGasLimit!),
      },
      maxFeePerGas: hexToBigInt(raw.maxFeePerGas as Hex),
      maxPriorityFeePerGas: hexToBigInt(raw.maxPriorityFeePerGas as Hex),
      fee: hexToBigInt(raw.fee as Hex),
      validForSec: raw.validForSec as number,
    };
  }
}
