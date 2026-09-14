import {
  createPublicClient,
  getAddress,
  hexToBigInt,
  http,
  isAddress,
  isAddressEqual,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { erc20MetadataAbi, paymasterAbi, tornadoInstanceAbi } from './abi.js';
import {
  BPS,
  DEFAULT_GAS,
  DEFAULT_TAIL_CALLS_GAS,
  ERC20_WITHDRAW_EXTRA_GAS,
  minimumFee,
  serviceFeeFor,
  withTailCalls,
} from './fee.js';
import { weiPerTokenFrom, type PriceSource } from './price.js';
import {
  DUMMY_SIGNATURE,
  encodePaymasterData,
  packInitCode,
  paymasterHash,
  q,
  readGas,
  type FeeTerms,
  type RpcUserOperation,
  type UserOpGas,
} from './userop.js';
import { decodeAccountCalls, findSponsoringWithdraw, ValidationError } from './validate.js';

export interface RelayerConfig {
  chainId: bigint;
  rpcUrl: string;
  /** Bundler RPC (Pimlico / alto). Used for gas prices and pre-signing simulation. */
  bundlerUrl?: string;
  entryPoint: Address;
  paymaster: Address;
  /** Private key of the paymaster's `verifyingSigner`. */
  signerKey: Hex;
  /** Tornado instances this relayer sponsors (ETH or ERC-20; detected on boot). */
  instances: Address[];
  /** Token pricing for ERC-20 instances. Required when any instance is an ERC-20 pool. */
  priceSource?: PriceSource;
  /** Service fee in basis points of the note denomination. */
  serviceFeeBps: bigint;
  /** How long a signature stays valid. Keep short: the fee is quoted at signing time. */
  signatureTtlSec: number;
  /** Run eth_estimateUserOperationGas on the bundler before signing. */
  simulateWithBundler: boolean;
  /** Multiplier (bps) applied to the bundler's fast gas price when quoting. */
  gasPriceMarginBps: bigint;
  sponsorName: string;
}

export interface InstanceInfo {
  address: Address;
  denomination: bigint;
  /** zeroAddress for ETH instances. */
  token: Address;
  decimals: number;
  symbol: string;
}

export interface QuoteParams {
  instance: Address;
  /** Extra callGasLimit for the caller's tail calls (swap, lend, forward ...). */
  tailCallsGas?: bigint;
  /** Overrides for individual gas fields (e.g. from a bundler estimate). */
  gas?: Partial<UserOpGas>;
  /** Override the max fee per gas the userOp will use. */
  maxFeePerGas?: bigint;
}

export interface Quote {
  relayer: Address;
  entryPoint: Address;
  instance: Address;
  denomination: bigint;
  /** zeroAddress for ETH instances. `fee`, `serviceFee` and `denomination` are in this token's units. */
  feeToken: Address;
  decimals: number;
  symbol: string;
  /** feeToken base units per 1e18 wei (0 for ETH). */
  tokenPerEth: bigint;
  serviceFeeBps: bigint;
  serviceFee: bigint;
  gasMarginBps: bigint;
  gas: UserOpGas;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The `fee` to bind into the withdrawal proof. */
  fee: bigint;
  validForSec: number;
}

/** ERC-7677 `context` understood by this relayer. */
export interface SponsorContext {
  /** Receives fee - actual gas - serviceFee in postOp. Defaults to the withdraw recipient. */
  refundTo?: Address;
}

export interface StubDataResult {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  isFinal: false;
  sponsor: { name: string };
}

export interface PaymasterDataResult {
  paymaster: Address;
  paymasterData: Hex;
  sponsor: { name: string };
  terms: {
    validUntil: number;
    validAfter: number;
    fee: Hex;
    serviceFee: Hex;
    refundTo: Address;
    feeToken: Address;
    tokenPerEth: Hex;
    minFee: Hex;
  };
}

interface PaymasterParams {
  gasMarginBps: bigint;
  postOpGasOverhead: bigint;
  verifyingSigner: Address;
}

interface SponsoredNote {
  validUntil: number;
  sender: Address;
  nonce: bigint;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: Logger = {
  info: (msg, meta) => console.log(`[relayer] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[relayer] ${msg}`, meta ?? ''),
};

/**
 * The thin relayer. Holds the signing key, knows the paymaster's economic
 * parameters, and turns "please sponsor this userOp" into a signature — or a
 * precise refusal.
 */
export class RelayerService {
  readonly signer: PrivateKeyAccount;
  private readonly sponsored = new Map<Hex, SponsoredNote>();

  private constructor(
    readonly config: RelayerConfig,
    readonly client: PublicClient,
    readonly paymasterParams: PaymasterParams,
    readonly instances: Map<Address, InstanceInfo>,
    private readonly log: Logger,
  ) {
    this.signer = privateKeyToAccount(config.signerKey);
  }

  static async create(config: RelayerConfig, log: Logger = consoleLogger): Promise<RelayerService> {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const chainId = BigInt(await client.getChainId());
    if (chainId !== config.chainId) {
      throw new Error(`RPC chain id ${chainId} does not match configured ${config.chainId}`);
    }

    const [entryPoint, verifyingSigner, gasMarginBps, postOpGasOverhead] = await Promise.all([
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'entryPoint' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'verifyingSigner' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'gasMarginBps' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'postOpGasOverhead' }),
    ]);
    if (!isAddressEqual(entryPoint, config.entryPoint)) {
      throw new Error(`paymaster is bound to EntryPoint ${entryPoint}, config says ${config.entryPoint}`);
    }
    const signer = privateKeyToAccount(config.signerKey);
    if (!isAddressEqual(verifyingSigner, signer.address)) {
      throw new Error(`paymaster.verifyingSigner is ${verifyingSigner} but our key is ${signer.address}`);
    }

    const instances = new Map<Address, InstanceInfo>();
    for (const raw of config.instances) {
      const address = getAddress(raw);
      const denomination = await client.readContract({ address, abi: tornadoInstanceAbi, functionName: 'denomination' });
      // ERC20Tornado exposes token(); ETHTornado does not.
      const token = await client
        .readContract({ address, abi: tornadoInstanceAbi, functionName: 'token' })
        .then((t) => getAddress(t))
        .catch(() => zeroAddress);
      let decimals = 18;
      let symbol = 'ETH';
      if (token !== zeroAddress) {
        if (!config.priceSource) throw new Error(`instance ${address} is an ERC-20 pool but no priceSource is configured`);
        [decimals, symbol] = await Promise.all([
          client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'decimals' }),
          client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'symbol' }).catch(() => 'TOKEN'),
        ]);
        // Fail fast if the token cannot be priced.
        await config.priceSource.tokenPerEth(token, decimals);
      }
      instances.set(address, { address, denomination, token, decimals, symbol });
    }

    const service = new RelayerService(
      { ...config, instances: [...instances.keys()] },
      client,
      { gasMarginBps, postOpGasOverhead, verifyingSigner },
      instances,
      log,
    );
    log.info('relayer ready', {
      chainId: chainId.toString(),
      paymaster: config.paymaster,
      signer: signer.address,
      instances: [...instances.values()].map((i) => `${i.address}:${i.denomination}${i.symbol}`),
      gasMarginBps: gasMarginBps.toString(),
      serviceFeeBps: config.serviceFeeBps.toString(),
    });
    return service;
  }

  // ------------------------------------------------------------------ status

  async status() {
    const ethPrices: Record<string, string> = {};
    for (const i of this.instances.values()) {
      if (i.token === zeroAddress) continue;
      try {
        const rate = await this.config.priceSource!.tokenPerEth(i.token, i.decimals);
        ethPrices[i.symbol.toLowerCase()] = weiPerTokenFrom(rate, i.decimals).toString();
      } catch (err) {
        this.log.warn('price unavailable', { token: i.token, err: String(err) });
      }
    }
    return {
      version: '0.2.0',
      chainId: toHex(this.config.chainId),
      entryPoint: this.config.entryPoint,
      paymaster: this.config.paymaster,
      /** Tornado convention: the address that must appear as `relayer` in the proof. */
      rewardAccount: this.config.paymaster,
      signer: this.signer.address,
      instances: [...this.instances.values()].map((i) => ({
        address: i.address,
        denomination: toHex(i.denomination),
        token: i.token,
        symbol: i.symbol,
        decimals: i.decimals,
      })),
      /** Tornado convention: wei per whole token, keyed by lowercase symbol. */
      ethPrices,
      serviceFeeBps: toHex(this.config.serviceFeeBps),
      /** Tornado convention: percentage. */
      tornadoServiceFee: Number(this.config.serviceFeeBps) / 100,
      gasMarginBps: toHex(this.paymasterParams.gasMarginBps),
      signatureTtlSec: this.config.signatureTtlSec,
      sponsor: { name: this.config.sponsorName },
    };
  }

  // ------------------------------------------------------------------ gas price

  async gasFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    let maxFeePerGas: bigint | undefined;
    let maxPriorityFeePerGas: bigint | undefined;

    if (this.config.bundlerUrl) {
      try {
        const res = (await this.bundlerRequest('pimlico_getUserOperationGasPrice', [])) as {
          fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
        };
        maxFeePerGas = hexToBigInt(res.fast.maxFeePerGas);
        maxPriorityFeePerGas = hexToBigInt(res.fast.maxPriorityFeePerGas);
      } catch (err) {
        this.log.warn('pimlico_getUserOperationGasPrice failed, falling back to RPC', { err: String(err) });
      }
    }
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      const fees = await this.client.estimateFeesPerGas();
      maxFeePerGas = fees.maxFeePerGas;
      maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    }
    const m = this.config.gasPriceMarginBps;
    return {
      maxFeePerGas: (maxFeePerGas * m) / BPS,
      maxPriorityFeePerGas: (maxPriorityFeePerGas * m) / BPS,
    };
  }

  // ------------------------------------------------------------------ pricing

  private instance(address: Address): InstanceInfo {
    const info = this.instances.get(getAddress(address));
    if (!info) throw new ValidationError(`instance ${address} is not served by this relayer`);
    return info;
  }

  /** 0 for ETH instances, else the current feeToken-per-ETH rate. */
  private async rateFor(info: InstanceInfo): Promise<bigint> {
    if (info.token === zeroAddress) return 0n;
    try {
      return await this.config.priceSource!.tokenPerEth(info.token, info.decimals);
    } catch (err) {
      throw new ValidationError(`cannot price ${info.symbol}: ${shortError(err)}`, -32008);
    }
  }

  // ------------------------------------------------------------------ quote

  async quote(params: QuoteParams): Promise<Quote> {
    const info = this.instance(params.instance);
    const isToken = info.token !== zeroAddress;

    const gas: UserOpGas = {
      ...withTailCalls(DEFAULT_GAS, (params.tailCallsGas ?? DEFAULT_TAIL_CALLS_GAS) + (isToken ? ERC20_WITHDRAW_EXTRA_GAS : 0n)),
      ...stripUndefined(params.gas ?? {}),
    };
    const fees = await this.gasFees();
    const maxFeePerGas = params.maxFeePerGas ?? fees.maxFeePerGas;
    const tokenPerEth = await this.rateFor(info);
    const serviceFee = serviceFeeFor(info.denomination, this.config.serviceFeeBps);
    const fee = minimumFee({
      gas,
      maxFeePerGas,
      gasMarginBps: this.paymasterParams.gasMarginBps,
      serviceFee,
      tokenPerEth,
    });
    if (fee >= info.denomination) {
      throw new ValidationError(
        `quoted fee ${fee} is not below the ${info.denomination} ${info.symbol} denomination at ${maxFeePerGas} wei/gas`,
      );
    }
    return {
      relayer: this.config.paymaster,
      entryPoint: this.config.entryPoint,
      instance: info.address,
      denomination: info.denomination,
      feeToken: info.token,
      decimals: info.decimals,
      symbol: info.symbol,
      tokenPerEth,
      serviceFeeBps: this.config.serviceFeeBps,
      serviceFee,
      gasMarginBps: this.paymasterParams.gasMarginBps,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : fees.maxPriorityFeePerGas,
      fee,
      validForSec: this.config.signatureTtlSec,
    };
  }

  // ------------------------------------------------------------------ ERC-7677

  /** pm_getPaymasterStubData: shape-correct paymaster fields for gas estimation. */
  stubData(op: RpcUserOperation, context: SponsorContext = {}): StubDataResult {
    let fee = 0n;
    let feeToken: Address = zeroAddress;
    let refundTo: Address = context.refundTo ?? op.sender;
    try {
      const w = findSponsoringWithdraw(decodeAccountCalls(op.callData), this.config.paymaster, this.config.instances);
      fee = w.fee;
      feeToken = this.instance(w.instance).token;
      refundTo = context.refundTo ?? w.recipient;
    } catch {
      // Estimation may run before the withdraw call is final; a zero fee still exercises postOp.
    }
    const now = Math.floor(Date.now() / 1000);
    const terms: FeeTerms = {
      validUntil: now + this.config.signatureTtlSec,
      validAfter: 0,
      fee,
      serviceFee: 0n,
      refundTo,
      feeToken,
      tokenPerEth: 0n,
    };
    return {
      paymaster: this.config.paymaster,
      paymasterData: encodePaymasterData(terms, DUMMY_SIGNATURE),
      paymasterVerificationGasLimit: toHex(DEFAULT_GAS.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: toHex(DEFAULT_GAS.paymasterPostOpGasLimit),
      isFinal: false,
      sponsor: { name: this.config.sponsorName },
    };
  }

  /** pm_getPaymasterData: validate the sponsored withdraw and sign. */
  async sign(op: RpcUserOperation, context: SponsorContext = {}): Promise<PaymasterDataResult> {
    if (op.paymaster && !isAddressEqual(op.paymaster, this.config.paymaster)) {
      throw new ValidationError(`userOp.paymaster must be ${this.config.paymaster}`);
    }
    if (context.refundTo !== undefined && !isAddress(context.refundTo)) {
      throw new ValidationError('context.refundTo is not an address');
    }

    // 1. The callData must perform exactly one withdraw that pays this paymaster.
    const calls = decodeAccountCalls(op.callData);
    const w = findSponsoringWithdraw(calls, this.config.paymaster, this.config.instances);
    const info = this.instance(w.instance);
    if (w.fee > info.denomination) throw new ValidationError('fee exceeds denomination');

    // 2. The fee must cover the worst case the paymaster can be charged for this exact op.
    const gas = readGas(op);
    const maxFeePerGas = q(op.maxFeePerGas, 'maxFeePerGas');
    const maxPriorityFeePerGas = q(op.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
    if (maxPriorityFeePerGas > maxFeePerGas) throw new ValidationError('maxPriorityFeePerGas exceeds maxFeePerGas');
    const tokenPerEth = await this.rateFor(info);
    const serviceFee = serviceFeeFor(info.denomination, this.config.serviceFeeBps);
    const minFee = minimumFee({
      gas,
      maxFeePerGas,
      gasMarginBps: this.paymasterParams.gasMarginBps,
      serviceFee,
      tokenPerEth,
    });
    if (w.fee < minFee) {
      throw new ValidationError(
        `fee ${w.fee} is below the minimum ${minFee} ${info.symbol} for these gas limits at ${maxFeePerGas} wei/gas`,
        -32002,
      );
    }

    // 3. One live sponsorship per note: a second signature could only ever burn our gas.
    this.pruneSponsored();
    const live = this.sponsored.get(w.nullifierHash);
    const nonce = q(op.nonce, 'nonce');
    if (live && !(isAddressEqual(live.sender, op.sender) && live.nonce === nonce)) {
      throw new ValidationError(`note already sponsored; signature valid until ${live.validUntil}`, -32003);
    }

    // 4. On-chain sanity: the proof must verify against the instance right now.
    await this.assertWithdrawSimulates(w);

    // 5. Optional full simulation on the bundler (validation + execution incl. tail calls).
    if (this.config.simulateWithBundler) await this.assertBundlerSimulates(op, context);

    // 6. Sign.
    const now = Math.floor(Date.now() / 1000);
    const terms: FeeTerms = {
      validUntil: now + this.config.signatureTtlSec,
      validAfter: 0,
      fee: w.fee,
      serviceFee,
      refundTo: context.refundTo ?? w.recipient,
      feeToken: info.token,
      tokenPerEth,
    };
    const hash = paymasterHash({ op, chainId: this.config.chainId, paymaster: this.config.paymaster, terms });
    const signature = await this.signer.signMessage({ message: { raw: hash } });

    this.sponsored.set(w.nullifierHash, { validUntil: terms.validUntil, sender: op.sender, nonce });
    this.log.info('sponsored', {
      instance: w.instance,
      symbol: info.symbol,
      nullifierHash: w.nullifierHash,
      sender: op.sender,
      fee: w.fee.toString(),
      minFee: minFee.toString(),
      tokenPerEth: tokenPerEth.toString(),
      refundTo: terms.refundTo,
      validUntil: terms.validUntil,
    });

    return {
      paymaster: this.config.paymaster,
      paymasterData: encodePaymasterData(terms, signature),
      sponsor: { name: this.config.sponsorName },
      terms: {
        validUntil: terms.validUntil,
        validAfter: terms.validAfter,
        fee: toHex(terms.fee),
        serviceFee: toHex(terms.serviceFee),
        refundTo: terms.refundTo,
        feeToken: terms.feeToken,
        tokenPerEth: toHex(terms.tokenPerEth),
        minFee: toHex(minFee),
      },
    };
  }

  // ------------------------------------------------------------------ internals

  private async assertWithdrawSimulates(w: ReturnType<typeof findSponsoringWithdraw>) {
    const [spent, known] = await Promise.all([
      this.client.readContract({
        address: w.instance,
        abi: tornadoInstanceAbi,
        functionName: 'isSpent',
        args: [w.nullifierHash],
      }),
      this.client.readContract({
        address: w.instance,
        abi: tornadoInstanceAbi,
        functionName: 'isKnownRoot',
        args: [w.root],
      }),
    ]);
    if (spent) throw new ValidationError('note already spent', -32004);
    if (!known) throw new ValidationError('merkle root is not known to the instance (stale tree?)', -32005);
    try {
      await this.client.simulateContract({
        address: w.instance,
        abi: tornadoInstanceAbi,
        functionName: 'withdraw',
        args: [w.proof, w.root, w.nullifierHash, w.recipient, w.relayer, w.fee, w.refund],
        account: this.signer.address,
      });
    } catch (err) {
      throw new ValidationError(`withdraw simulation failed: ${shortError(err)}`, -32006);
    }
  }

  private async assertBundlerSimulates(op: RpcUserOperation, context: SponsorContext) {
    if (!this.config.bundlerUrl) return;
    const stub = this.stubData(op, context);
    const simulated: RpcUserOperation = {
      ...op,
      paymaster: stub.paymaster,
      paymasterData: stub.paymasterData,
      paymasterVerificationGasLimit: op.paymasterVerificationGasLimit ?? stub.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: op.paymasterPostOpGasLimit ?? stub.paymasterPostOpGasLimit,
      signature: op.signature ?? DUMMY_SIGNATURE,
    };
    delete (simulated as { initCode?: Hex }).initCode;
    if (op.initCode !== undefined && !op.factory) {
      // Normalise a v0.6-style initCode for the bundler's v0.7+ schema.
      const initCode = packInitCode(op);
      if (initCode !== '0x') {
        simulated.factory = initCode.startsWith('0x7702') ? '0x7702' : (`0x${initCode.slice(2, 42)}` as Address);
        simulated.factoryData = initCode.startsWith('0x7702')
          ? (`0x${initCode.slice(6)}` as Hex)
          : (`0x${initCode.slice(42)}` as Hex);
      }
    }
    try {
      await this.bundlerRequest('eth_estimateUserOperationGas', [simulated, this.config.entryPoint]);
    } catch (err) {
      throw new ValidationError(`bundler simulation failed: ${shortError(err)}`, -32007);
    }
  }

  private async bundlerRequest(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.config.bundlerUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
    if (body.error) throw new Error(body.error.message + (body.error.data ? ` ${JSON.stringify(body.error.data)}` : ''));
    return body.result;
  }

  private pruneSponsored() {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of this.sponsored) if (v.validUntil < now) this.sponsored.delete(k);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function shortError(err: unknown): string {
  if (err && typeof err === 'object' && 'shortMessage' in err) return String((err as { shortMessage: string }).shortMessage);
  return err instanceof Error ? err.message : String(err);
}
