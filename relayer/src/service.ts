import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeErrorResult,
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

import { erc20MetadataAbi, feeManagerAbi, paymasterAbi, relayerRegistryAbi, tornadoInstanceAbi, tornadoRouterAbi } from './abi.js';
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
  withdrawalHash,
  type FeeTerms,
  type RpcUserOperation,
  type UserOpGas,
} from './userop.js';
import { delegationCode } from './setup.js';
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
  /**
   * Address the withdrawal proof names as `relayer` (Tornado's fee recipient). Defaults to the
   * paymaster (master mode: fee lands on the paymaster, excess refunded). Set it to an existing
   * relayer's master EOA once the paymaster is registered as its worker (worker mode: fee goes
   * to the master as today, fixed fee, no refund).
   */
  rewardAccount?: Address;
  /** Start even if the paymaster is not registered in the RelayerRegistry the router uses. */
  allowUnregistered?: boolean;
  /** Where live sponsorships are kept (default: in memory). */
  sponsorshipStore?: SponsorshipStore;
  /**
   * Optional defence in depth: only sponsor senders whose code (or pending EIP-7702 delegation) is one
   * of these implementations, e.g. Simple7702Account v0.8. The sponsorship is bound on-chain to the exact
   * withdrawal regardless; this only avoids paying gas for accounts that would revert anyway.
   */
  allowedSenderImplementations?: Address[];
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
  /** Address to bind as `relayer` in the proof (fee recipient). */
  relayer: Address;
  /** Contract whose `relayWithdraw` the userOp must call. */
  paymaster: Address;
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
    withdrawalHash: Hex;
    senderImplementation: Address;
    minFee: Hex;
  };
}

interface PaymasterParams {
  gasMarginBps: bigint;
  postOpGasOverhead: bigint;
  verifyingSigner: Address;
}

/** How the paymaster relates to the DAO's TornadoRouter / RelayerRegistry. */
export interface RegistryInfo {
  /** `master`: the paymaster owns a stake; `worker`: it works for `master`; `unregistered`: router set, no
   * registration (withdrawals go through as a "custom relayer", no burn); `no-router`: pools called directly. */
  mode: 'master' | 'worker' | 'unregistered' | 'no-router';
  router: Address;
  relayerRegistry: Address;
  /** Registry master the paymaster resolves to (itself in master mode). */
  master: Address;
  /** TORN stake left for that master (wei). */
  stake: bigint;
  minStake: bigint;
  ensHash: Hex;
  /** TORN burned per withdrawal, per instance (from FeeManager.instanceFee; 0 = no protocol fee). */
  burnPerWithdraw: Record<Address, bigint>;
}

export interface SponsoredNote {
  validUntil: number;
  sender: Address;
  nonce: bigint;
  /** `pending` while the request is being checked, `signed` once a signature went out. */
  status: 'pending' | 'signed';
  /** Identifies the request that holds the entry; only it may release or commit it. */
  token: string;
}

/**
 * Live sponsorships by nullifier: one signature per note at a time. `reserve` is the check-and-set
 * that guards the whole signing path (it runs before any await, so concurrent requests for the same
 * note cannot both pass); the reservation is `pending` until `commit` marks it `signed`, and
 * `release` only removes the pending entry of the request that made it — a signed, still-valid
 * sponsorship is never dropped by a later failed request. The default is in-memory; the file store
 * survives restarts. Several relayer instances sharing a key need a shared store whose `reserve` is
 * atomic on the backend (SETNX-style), not these.
 */
export interface SponsorshipStore {
  get(nullifierHash: Hex): SponsoredNote | undefined;
  /** Atomically claim the note as `pending`; refused while any unexpired entry exists. */
  reserve(nullifierHash: Hex, note: Omit<SponsoredNote, 'status' | 'token'>): { ok: true; token: string } | { ok: false; held: SponsoredNote };
  /** Mark the reservation `token` holds as signed. */
  commit(nullifierHash: Hex, token: string): void;
  /** Drop the reservation `token` holds if it is still pending (no-op otherwise). */
  release(nullifierHash: Hex, token: string): void;
  prune(now: number): void;
}

export class MemorySponsorshipStore implements SponsorshipStore {
  protected readonly notes = new Map<Hex, SponsoredNote>();
  private seq = 0;
  get(k: Hex) {
    return this.notes.get(k);
  }
  protected set(k: Hex, v: SponsoredNote) {
    this.notes.set(k, v);
  }
  protected delete(k: Hex) {
    this.notes.delete(k);
  }
  reserve(k: Hex, note: Omit<SponsoredNote, 'status' | 'token'>): { ok: true; token: string } | { ok: false; held: SponsoredNote } {
    const held = this.notes.get(k);
    if (held) return { ok: false, held };
    const token = `${Date.now()}-${++this.seq}`;
    this.set(k, { ...note, status: 'pending', token });
    return { ok: true, token };
  }
  commit(k: Hex, token: string) {
    const held = this.notes.get(k);
    if (held && held.token === token) this.set(k, { ...held, status: 'signed' });
  }
  release(k: Hex, token: string) {
    const held = this.notes.get(k);
    if (held && held.token === token && held.status === 'pending') this.delete(k);
  }
  prune(now: number) {
    for (const [k, v] of this.notes) if (v.validUntil < now) this.delete(k);
  }
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
  private readonly sponsored: SponsorshipStore;

  readonly rewardAccount: Address;

  private constructor(
    readonly config: RelayerConfig,
    readonly client: PublicClient,
    readonly paymasterParams: PaymasterParams,
    readonly instances: Map<Address, InstanceInfo>,
    readonly registry: RegistryInfo,
    private readonly log: Logger,
  ) {
    this.signer = privateKeyToAccount(config.signerKey);
    this.rewardAccount = getAddress(config.rewardAccount ?? config.paymaster);
    this.sponsored = config.sponsorshipStore ?? new MemorySponsorshipStore();
  }

  /** Worker mode: the fee is paid to the master EOA, so nothing can be refunded by the paymaster. */
  get refunds(): boolean {
    return isAddressEqual(this.rewardAccount, this.config.paymaster);
  }

  static async create(config: RelayerConfig, log: Logger = consoleLogger): Promise<RelayerService> {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const chainId = BigInt(await client.getChainId());
    if (chainId !== config.chainId) {
      throw new Error(`RPC chain id ${chainId} does not match configured ${config.chainId}`);
    }

    const [entryPoint, verifyingSigner, gasMarginBps, postOpGasOverhead, router] = await Promise.all([
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'entryPoint' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'verifyingSigner' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'gasMarginBps' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'postOpGasOverhead' }),
      client.readContract({ address: config.paymaster, abi: paymasterAbi, functionName: 'router' }),
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

    const registry = await probeRegistry(client, config.paymaster, getAddress(router), [...instances.keys()]);
    const rewardAccount = getAddress(config.rewardAccount ?? config.paymaster);
    if (registry.mode === 'no-router') {
      log.warn('paymaster has no TornadoRouter: withdrawals bypass the RelayerRegistry (no TORN burn)');
      if (!isAddressEqual(rewardAccount, config.paymaster)) {
        throw new Error('REWARD_ACCOUNT other than the paymaster needs the paymaster to be a registry worker (router required)');
      }
    } else if (registry.mode === 'unregistered') {
      const msg =
        `paymaster ${config.paymaster} is not registered in RelayerRegistry ${registry.relayerRegistry}: ` +
        'register it as a master (ENS name + TORN stake, see registerAsRelayer) or as a worker of your relayer';
      if (!config.allowUnregistered) throw new Error(msg);
      log.warn(msg);
    } else if (!isAddressEqual(registry.master, rewardAccount)) {
      throw new Error(
        `the registry resolves the paymaster to master ${registry.master} but REWARD_ACCOUNT is ${rewardAccount}: ` +
          'the proof must name the master or Router.withdraw reverts with "only relayer"',
      );
    }

    const service = new RelayerService(
      { ...config, instances: [...instances.keys()] },
      client,
      { gasMarginBps, postOpGasOverhead, verifyingSigner },
      instances,
      registry,
      log,
    );
    log.info('relayer ready', {
      chainId: chainId.toString(),
      paymaster: config.paymaster,
      rewardAccount,
      registryMode: registry.mode,
      master: registry.master,
      stakeTorn: registry.stake.toString(),
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
      rewardAccount: this.rewardAccount,
      /** Whether postOp refunds `fee - gas - serviceFee` (master mode) or the fee is fixed (worker mode). */
      refunds: this.refunds,
      registry: {
        mode: this.registry.mode,
        router: this.registry.router,
        relayerRegistry: this.registry.relayerRegistry,
        master: this.registry.master,
        stake: toHex(this.registry.stake),
        minStake: toHex(this.registry.minStake),
        ensHash: this.registry.ensHash,
        burnPerWithdraw: Object.fromEntries(
          Object.entries(this.registry.burnPerWithdraw).map(([k, v]) => [k, toHex(v)]),
        ),
      },
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
      relayer: this.rewardAccount,
      paymaster: this.config.paymaster,
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
    let refundTo: Address = this.refunds ? (context.refundTo ?? op.sender) : zeroAddress;
    let approved: Hex = `0x${'00'.repeat(32)}`;
    try {
      const w = findSponsoringWithdraw(decodeAccountCalls(op.callData), this.rules(op.sender));
      fee = w.fee;
      feeToken = this.instance(w.instance).token;
      if (this.refunds) refundTo = context.refundTo ?? w.recipient;
      approved = withdrawalHash(w);
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
      withdrawalHash: approved,
      senderImplementation: senderImplementationFromOp(op) ?? zeroAddress,
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

    // 1. The callData must perform exactly one relayWithdraw on the paymaster that pays rewardAccount.
    const calls = decodeAccountCalls(op.callData);
    const w = findSponsoringWithdraw(calls, this.rules(op.sender));
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

    // 3. One live sponsorship per note: a second signature could only ever burn our gas. The note is
    //    reserved here — synchronously, before any await — and released if a later check fails.
    const now = Math.floor(Date.now() / 1000);
    this.sponsored.prune(now);
    const nonce = q(op.nonce, 'nonce');
    const validUntil = now + this.config.signatureTtlSec;
    const reserved = this.sponsored.reserve(w.nullifierHash, { validUntil, sender: op.sender, nonce });
    if (!reserved.ok) {
      throw new ValidationError(
        `note already ${reserved.held.status === 'signed' ? 'sponsored' : 'being sponsored'}; valid until ${reserved.held.validUntil}`,
        -32003,
      );
    }
    const token = reserved.token;
    let senderImplementation: Address;
    try {
      // 4. The implementation that will run the op: the op's own EIP-7702 authorization, else the
      //    sender's current delegation. It is signed into the terms and re-checked by the paymaster at
      //    validation, so a client cannot swap authorizations after the signature. Optionally allowlisted.
      senderImplementation = await this.resolveSenderImplementation(op);

      // 5. On-chain sanity: the proof must verify against the instance right now.
      await this.assertWithdrawSimulates(w);

      // 6. Optional full simulation on the bundler (validation + execution incl. tail calls).
      if (this.config.simulateWithBundler) await this.assertBundlerSimulates(op, context);
    } catch (err) {
      this.sponsored.release(w.nullifierHash, token);
      throw err;
    }

    // 7. Sign.
    const terms: FeeTerms = {
      validUntil,
      validAfter: 0,
      fee: w.fee,
      serviceFee,
      // Worker mode: the fee is paid to the master EOA, the paymaster has nothing to refund.
      refundTo: this.refunds ? (context.refundTo ?? w.recipient) : zeroAddress,
      feeToken: info.token,
      tokenPerEth,
      // Binds the sponsorship to exactly this relayWithdraw call, whatever the sender account executes.
      withdrawalHash: withdrawalHash(w),
      // … and to the account implementation that will execute it.
      senderImplementation,
    };
    const hash = paymasterHash({ op, chainId: this.config.chainId, paymaster: this.config.paymaster, terms });
    let signature: Hex;
    try {
      signature = await this.signer.signMessage({ message: { raw: hash } });
    } catch (err) {
      this.sponsored.release(w.nullifierHash, token);
      throw err;
    }
    this.sponsored.commit(w.nullifierHash, token);
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
        withdrawalHash: terms.withdrawalHash,
        senderImplementation: terms.senderImplementation,
        minFee: toHex(minFee),
      },
    };
  }

  // ------------------------------------------------------------------ internals

  private rules(sender: Address) {
    return {
      paymaster: this.config.paymaster,
      rewardAccount: this.rewardAccount,
      allowedInstances: this.config.instances,
      sender,
    };
  }

  /**
   * Proof + registry check: dry-run the relay through `simulateRelayWithdraw`, which grants the
   * sponsorship the EntryPoint would grant, runs Router -> burn -> pool.withdraw, and reverts with the
   * result so nothing persists.
   */
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
    // simulateRelayWithdraw always reverts with SimulationResult(success, innerResult).
    let outcome: { success: boolean; result: Hex } | undefined;
    try {
      await this.client.simulateContract({
        address: this.config.paymaster,
        abi: paymasterAbi,
        functionName: 'simulateRelayWithdraw',
        args: [w.instance, w.proof, w.root, w.nullifierHash, w.recipient, w.relayer, w.fee],
        account: w.recipient,
      });
    } catch (err) {
      const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
      const data = reverted instanceof ContractFunctionRevertedError ? reverted.data : undefined;
      if (data?.errorName === 'SimulationResult') {
        const [success, result] = data.args as readonly [boolean, Hex];
        outcome = { success, result };
      } else {
        throw new ValidationError(`relay simulation failed: ${data?.errorName ?? shortError(err)}`, -32006);
      }
    }
    if (!outcome) throw new ValidationError('relay simulation did not revert with SimulationResult', -32006);
    if (!outcome.success) {
      throw new ValidationError(`relayWithdraw would revert: ${decodeRevert(outcome.result)}`, -32006);
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
    // A sender that is only delegated by the op's own EIP-7702 authorization has no code yet; strict
    // bundlers (eth-infinitism) estimate exactly what the node sees, so show them the delegated sender.
    const authorized = senderImplementationFromOp(op);
    const stateOverride =
      authorized && ((await this.client.getCode({ address: op.sender })) ?? '0x') === '0x'
        ? { [op.sender]: { code: delegationCode(authorized) } }
        : undefined;
    try {
      await this.bundlerRequest('eth_estimateUserOperationGas', [simulated, this.config.entryPoint, ...(stateOverride ? [stateOverride] : [])]);
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

  /**
   * The implementation that will execute the op: the op's own EIP-7702 authorization when it carries
   * one (it is applied before validation and replaces whatever code the sender has), otherwise the
   * sender's current delegation. Only EIP-7702 senders are sponsored: the paymaster re-checks the
   * delegation designator on-chain, which is what makes the binding hold after signing.
   */
  private async resolveSenderImplementation(op: RpcUserOperation): Promise<Address> {
    let implementation = senderImplementationFromOp(op);
    let source = 'eip7702Auth';
    if (!implementation) {
      const code = ((await this.client.getCode({ address: op.sender })) ?? '0x').toLowerCase();
      if (code.startsWith('0xef0100') && code.length === 2 + 46) implementation = getAddress(`0x${code.slice(8)}`);
      else if (code === '0x') throw new ValidationError('sender has no code and the op carries no EIP-7702 authorization', -32009);
      else throw new ValidationError('only EIP-7702 senders are sponsored (sender is a contract account)', -32009);
      source = 'delegation';
    }
    const allowed = this.config.allowedSenderImplementations;
    if (allowed && allowed.length > 0 && !allowed.some((a) => isAddressEqual(a, implementation!))) {
      throw new ValidationError(`sender implementation ${implementation} (${source}) is not sponsored`, -32009);
    }
    return implementation;
  }
}

/** Read how the paymaster is registered with the DAO's Router / RelayerRegistry. */
export async function probeRegistry(
  client: PublicClient,
  paymaster: Address,
  router: Address,
  instances: Address[],
): Promise<RegistryInfo> {
  const none: RegistryInfo = {
    mode: 'no-router',
    router,
    relayerRegistry: zeroAddress,
    master: zeroAddress,
    stake: 0n,
    minStake: 0n,
    ensHash: `0x${'00'.repeat(32)}`,
    burnPerWithdraw: {},
  };
  if (router === zeroAddress) return none;
  const relayerRegistry = getAddress(
    await client.readContract({ address: router, abi: tornadoRouterAbi, functionName: 'relayerRegistry' }),
  );
  const [master, stake, minStake, ensHash, feeManager] = await Promise.all([
    client.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'workers', args: [paymaster] }),
    client.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'getRelayerBalance', args: [paymaster] }),
    client.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'minStakeAmount' }),
    client.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'getRelayerEnsHash', args: [paymaster] }),
    client.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'feeManager' }).catch(() => zeroAddress),
  ]);
  const burnPerWithdraw: Record<Address, bigint> = {};
  if (feeManager !== zeroAddress) {
    for (const instance of instances) {
      burnPerWithdraw[instance] = BigInt(
        await client
          .readContract({ address: feeManager, abi: feeManagerAbi, functionName: 'instanceFee', args: [instance] })
          .catch(() => 0n),
      );
    }
  }
  const mode: RegistryInfo['mode'] =
    master === zeroAddress ? 'unregistered' : isAddressEqual(master, paymaster) ? 'master' : 'worker';
  return { ...none, mode, relayerRegistry, master: getAddress(master), stake, minStake, ensHash, burnPerWithdraw };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Implementation named by the op's EIP-7702 authorization, if it carries one. */
function senderImplementationFromOp(op: RpcUserOperation): Address | undefined {
  const auth = (op as { eip7702Auth?: { address?: Address; contractAddress?: Address } }).eip7702Auth;
  const a = auth?.address ?? auth?.contractAddress;
  return a && isAddress(a) ? getAddress(a) : undefined;
}

/** Human-readable form of inner revert data (Error(string), Panic, or a raw selector). */
function decodeRevert(data: Hex): string {
  if (data.startsWith('0x08c379a0')) {
    try {
      const { args } = decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }], data });
      return String(args?.[0]);
    } catch {
      /* fall through */
    }
  }
  try {
    const { errorName } = decodeErrorResult({ abi: paymasterAbi, data });
    return errorName;
  } catch {
    return data === '0x' ? 'reverted without data' : data.slice(0, 74);
  }
}

function shortError(err: unknown): string {
  if (err && typeof err === 'object' && 'shortMessage' in err) return String((err as { shortMessage: string }).shortMessage);
  return err instanceof Error ? err.message : String(err);
}
