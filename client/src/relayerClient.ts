import { hexToBigInt, toHex, type Address, type Hex } from 'viem';

export interface RelayerQuote {
  /** Address to bind as `relayer` in the proof (the paymaster, or the master EOA in worker mode). */
  relayer: Address;
  /** TornadoRelayerPaymaster whose `relayWithdraw` the userOp calls. */
  paymaster: Address;
  entryPoint: Address;
  instance: Address;
  denomination: bigint;
  /** zeroAddress for ETH instances; `fee`, `serviceFee`, `denomination` are in this token's units. */
  feeToken: Address;
  decimals: number;
  symbol: string;
  /** feeToken base units per 1e18 wei (0 for ETH). */
  tokenPerEth: bigint;
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
  refunds: boolean;
  registry: {
    mode: 'master' | 'worker' | 'unregistered' | 'no-router';
    router: Address;
    relayerRegistry: Address;
    master: Address;
    stake: Hex;
    minStake: Hex;
    ensHash: Hex;
    burnPerWithdraw: Record<Address, Hex>;
  };
  signer: Address;
  instances: { address: Address; denomination: Hex; token: Address; symbol: string; decimals: number }[];
  ethPrices: Record<string, string>;
  serviceFeeBps: Hex;
  tornadoServiceFee: number;
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
      paymaster: raw.paymaster as Address,
      entryPoint: raw.entryPoint as Address,
      instance: raw.instance as Address,
      denomination: hexToBigInt(raw.denomination as Hex),
      feeToken: raw.feeToken as Address,
      decimals: raw.decimals as number,
      symbol: raw.symbol as string,
      tokenPerEth: hexToBigInt(raw.tokenPerEth as Hex),
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
