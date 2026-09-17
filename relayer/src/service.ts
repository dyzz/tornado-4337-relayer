import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
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

import { entryPointAbi, erc20MetadataAbi, feeManagerAbi, paymasterAbi, relayerRegistryAbi, tornadoInstanceAbi, tornadoRouterAbi } from './abi.js';
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
  totalGas,
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
  /**
   * Bundler RPC (Pimlico / alto). Required: every sponsorship is simulated there before it is signed
   * (`eth_estimateUserOperationGas`, which exercises the execution phase — the withdrawal and the
   * caller's tail calls — as well as validation), and the quote's gas price comes from it. There is no
   * way to switch the simulation off, and a configuration without a bundler is refused at start-up.
   *
   * The simulation is not a guarantee of payment. ERC-4337 validation-phase simulation does not promise
   * that execution succeeds at inclusion time, and a UserOperation that lands and then reverts in
   * execution is still paid for by the paymaster. The bounded exposure comes from the short signature
   * lifetime, the per-operation fee floor and the deposit budget, not from this call.
   */
  bundlerUrl: string;
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
   * The account implementations this relayer sponsors, e.g. Simple7702Account v0.8. Not optional and
   * never empty: `senderImplementation` binds the sponsorship to whichever implementation executes it,
   * but only an allowlist keeps a caller from asking for a sponsorship in the first place with an
   * account whose `execute` ignores the calldata — that operation would consume the paymaster's gas
   * without ever performing the withdrawal or paying the fee. `RelayerService.create` refuses an empty
   * list. Defaults to the canonical Simple7702Account for the chain (see `config.ts`).
   */
  allowedSenderImplementations: Address[];
  /** Tornado instances this relayer sponsors (ETH or ERC-20; detected on boot). */
  instances: Address[];
  /** Token pricing for ERC-20 instances. Required when any instance is an ERC-20 pool. */
  priceSource?: PriceSource;
  /** Service fee in basis points of the note denomination. */
  serviceFeeBps: bigint;
  /** How long a signature stays valid. Keep short: the fee is quoted at signing time. */
  signatureTtlSec: number;
  /** Per-request timeout for bundler JSON-RPC calls (default 20 s). A timeout refuses the sponsorship. */
  bundlerTimeoutMs?: number;
  /**
   * Gas budget, checked against the EntryPoint deposit before every signature.
   *   minDepositWei   stop signing while the deposit (minus what outstanding sponsorships could still
   *                   cost) would fall below this. Top the deposit up by hand; the service does not
   *                   move funds while it is serving.
   *   maxSponsorshipGasWei  refuse any single operation whose gas limits could cost more than this.
   */
  minDepositWei?: bigint;
  maxSponsorshipGasWei?: bigint;
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
  /**
   * The most the EntryPoint can charge the paymaster for this operation (its gas limits at its
   * `maxFeePerGas`). Outstanding entries are summed when the next request is checked against the
   * deposit, so a burst of concurrent requests cannot each treat the same balance as free.
   */
  maxGasCostWei?: bigint;
}

/**
 * Live sponsorships by nullifier: one signature per note at a time. `reserve` is the check-and-set
 * that guards the whole signing path (it runs before any await, so concurrent requests for the same
 * note cannot both pass); the reservation is `pending` until `commit` marks it `signed`, and
 * `release` only removes the pending entry of the request that made it — a signed, still-valid
 * sponsorship is never dropped by a later failed request. The default is in-memory; the file store
 * survives restarts. Several relayer instances sharing a key need a shared store whose `reserve` is
 * atomic on the backend (SETNX-style), not these.
 *
 * Durability is only owed to *signed* entries: a pending reservation belongs to a request that is still
 * in this process and dies with it. So `reserve`, `release` and `prune` never touch durable storage and
 * cannot fail for storage reasons, and `commit` writes before it changes anything — if it throws, the
 * entry is exactly as it was (still pending) and the caller must not issue the signature.
 */
export interface SponsorshipStore {
  get(nullifierHash: Hex): SponsoredNote | undefined;
  /** Atomically claim the note as `pending`; refused while any unexpired entry exists. No I/O. */
  reserve(nullifierHash: Hex, note: Omit<SponsoredNote, 'status' | 'token'>): { ok: true; token: string } | { ok: false; held: SponsoredNote };
  /**
   * Record the reservation `token` holds as signed, durably, before returning. Throws — leaving the
   * entry pending — when it cannot be recorded or when `token` no longer holds the reservation.
   */
  commit(nullifierHash: Hex, token: string): void;
  /** Drop the reservation `token` holds if it is still pending (no-op otherwise). No I/O. */
  release(nullifierHash: Hex, token: string): void;
  /** Forget entries that expired before `now`. No I/O: a durable copy of an expired entry is harmless. */
  prune(now: number): void;
  /** Every entry still live at `now`: pending and signed sponsorships the paymaster may still pay for. */
  outstanding(now: number): SponsoredNote[];
}

export class MemorySponsorshipStore implements SponsorshipStore {
  protected readonly notes = new Map<Hex, SponsoredNote>();
  private seq = 0;
  get(k: Hex) {
    return this.notes.get(k);
  }
  reserve(k: Hex, note: Omit<SponsoredNote, 'status' | 'token'>): { ok: true; token: string } | { ok: false; held: SponsoredNote } {
    const held = this.notes.get(k);
    if (held) return { ok: false, held };
    const token = `${Date.now()}-${++this.seq}`;
    this.notes.set(k, { ...note, status: 'pending', token });
    return { ok: true, token };
  }
  commit(k: Hex, token: string) {
    const held = this.notes.get(k);
    if (!held || held.token !== token) {
      // Losing the reservation mid-request means another request may now own the note: never
      // record a signature for it.
      throw new Error(`sponsorship reservation for ${k} is no longer held by this request`);
    }
    const next: SponsoredNote = { ...held, status: 'signed' };
    this.persistSigned(k, next); // durable stores write first; a throw leaves memory untouched
    this.notes.set(k, next);
  }
  release(k: Hex, token: string) {
    const held = this.notes.get(k);
    if (held && held.token === token && held.status === 'pending') this.notes.delete(k);
  }
  prune(now: number) {
    for (const [k, v] of this.notes) if (v.validUntil < now) this.notes.delete(k);
  }
  outstanding(now: number): SponsoredNote[] {
    return [...this.notes.values()].filter((v) => v.validUntil >= now);
  }
  /** Durable stores record `next` (a newly signed entry) here, before it becomes visible. */
  protected persistSigned(_k: Hex, _next: SponsoredNote): void {}
}

/**
 * What the live sponsorships can still cost the paymaster, for the deposit budget.
 *
 * An entry restored from a store written by a release that predates the budget carries no gas cost.
 * Such an entry is never counted as zero: it is counted at the per-operation cap when one is
 * configured, and otherwise the total is unknown until it expires — the caller must not sign then.
 * Signatures live for `signatureTtlSec`, so this lasts at most that long after an upgrade.
 */
export function committedGasCost(
  notes: SponsoredNote[],
  perOperationCap?: bigint,
): { known: true; wei: bigint } | { known: false; unknown: number; until: number } {
  let wei = 0n;
  let unknown = 0;
  let until = 0;
  for (const n of notes) {
    if (n.maxGasCostWei !== undefined) wei += n.maxGasCostWei;
    else if (perOperationCap !== undefined) wei += perOperationCap;
    else {
      unknown++;
      until = Math.max(until, n.validUntil);
    }
  }
  return unknown > 0 ? { known: false, unknown, until } : { known: true, wei };
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

  /** The live sponsorship store (read-only use: which notes are reserved or signed right now). */
  get sponsorships(): SponsorshipStore {
    return this.sponsored;
  }

  /** Worker mode: the fee is paid to the master EOA, so nothing can be refunded by the paymaster. */
  get refunds(): boolean {
    return isAddressEqual(this.rewardAccount, this.config.paymaster);
  }

  static async create(config: RelayerConfig, log: Logger = consoleLogger): Promise<RelayerService> {
    // Refuse the two configurations that would silently widen what gets sponsored.
    if (!config.allowedSenderImplementations || config.allowedSenderImplementations.length === 0) {
      throw new Error(
        'allowedSenderImplementations must list at least one account implementation: an unrestricted relayer ' +
          'would sponsor an account whose execute() ignores the calldata, paying gas for no withdrawal',
      );
    }
    if (!config.bundlerUrl) {
      throw new Error('BUNDLER_URL is required: sponsorships are simulated on the bundler before they are signed');
    }
    if ((config as { simulateWithBundler?: boolean }).simulateWithBundler === false) {
      throw new Error('the pre-signing bundler simulation cannot be disabled');
    }
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
      // ERC20Tornado exposes token(); ETHTornado does not, and calling it reverts. Only that revert
      // means "ETH pool": a transport failure must stop the start-up, not reclassify an ERC-20 pool.
      const token = await client
        .readContract({ address, abi: tornadoInstanceAbi, functionName: 'token' })
        .then((t) => getAddress(t))
        .catch((err) => {
          if (isContractRevert(err)) return zeroAddress;
          throw new Error(`cannot read ${address}.token(): ${shortError(err)}`);
        });
      let decimals = 18;
      let symbol = 'ETH';
      if (token !== zeroAddress) {
        if (!config.priceSource) throw new Error(`instance ${address} is an ERC-20 pool but no priceSource is configured`);
        [decimals, symbol] = await Promise.all([
          client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'decimals' }),
          client.readContract({ address: token, abi: erc20MetadataAbi, functionName: 'symbol' }).catch((err) => {
            if (isContractRevert(err)) return 'TOKEN'; // a token without symbol(): cosmetic only
            throw new Error(`cannot read ${token}.symbol(): ${shortError(err)}`);
          }),
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

    const restoredWithoutCost = committedGasCost(
      (config.sponsorshipStore ?? new MemorySponsorshipStore()).outstanding(Math.floor(Date.now() / 1000)),
      config.maxSponsorshipGasWei,
    );
    if (!restoredWithoutCost.known) {
      log.warn(
        `${restoredWithoutCost.unknown} live sponsorships were restored from an earlier release without a recorded gas ` +
          `cost and no MAX_SPONSORSHIP_GAS_WEI is set to budget them: new sponsorships are refused until they expire ` +
          `at ${new Date(restoredWithoutCost.until * 1000).toISOString()}`,
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

  /**
   * A live view, not the start-up snapshot: the deposit, the stake, the worker -> master relationship
   * and the per-withdrawal burn are re-read on every call. Anything that cannot be read is reported as
   * unavailable rather than served as a stale value, and `checkedAt` / `checkedAtBlock` say how fresh
   * the numbers are.
   */
  async status() {
    const now = Math.floor(Date.now() / 1000);
    this.sponsored.prune(now);
    const live = await this.liveState(now);
    // Every value below is either read now or null; `unavailable` says why each null is null.
    const unavailable: Record<string, string> = { ...live.unavailable };
    const ethPrices: Record<string, string> = {};
    for (const i of this.instances.values()) {
      if (i.token === zeroAddress) continue;
      try {
        const rate = await this.config.priceSource!.tokenPerEth(i.token, i.decimals);
        ethPrices[i.symbol.toLowerCase()] = weiPerTokenFrom(rate, i.decimals).toString();
      } catch (err) {
        unavailable[`ethPrices.${i.symbol.toLowerCase()}`] = shortError(err);
      }
    }
    const reg = live.registry;
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
        /** Read now. Null when the registry could not be read (see `unavailable.registry`). */
        mode: reg?.mode ?? null,
        master: reg?.master ?? null,
        stake: reg ? toHex(reg.stake) : null,
        minStake: reg ? toHex(reg.minStake) : null,
        burnPerWithdraw: reg ? Object.fromEntries(Object.entries(reg.burnPerWithdraw).map(([k, v]) => [k, toHex(v)])) : null,
        router: this.registry.router,
        relayerRegistry: this.registry.relayerRegistry,
        ensHash: this.registry.ensHash,
        /** What start-up saw. A difference from `mode` / `master` means the registration has moved. */
        modeAtStartup: this.registry.mode,
        masterAtStartup: this.registry.master,
      },
      /** EntryPoint balances and what is already promised out of them. */
      deposit: {
        wei: live.deposit === undefined ? null : toHex(live.deposit),
        stakeWei: live.stake === undefined ? null : toHex(live.stake),
        minWei: toHex(this.config.minDepositWei ?? 0n),
        /** Null while restored sponsorships without a recorded cost are live (see `unavailable`). */
        committedWei: live.committed.known ? toHex(live.committed.wei) : null,
        /** false while the relayer refuses new sponsorships for budget reasons (or cannot tell). */
        accepting: live.accepting,
      },
      /** Whether the registry, read now, still resolves the paymaster to `rewardAccount`. */
      registered: reg ? live.registrationCurrent : null,
      /** When these numbers were read. */
      checkedAt: now,
      checkedAtBlock: live.blockNumber === undefined ? null : toHex(live.blockNumber),
      unavailable,
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
    // What the EntryPoint can charge us for this operation at its own gas limits and price.
    const maxGasCostWei = totalGas(gas) * maxFeePerGas;
    const reserved = this.sponsored.reserve(w.nullifierHash, { validUntil, sender: op.sender, nonce, maxGasCostWei });
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

      // 5. The deposit has to cover this operation *and* everything already promised. The reservation
      //    is already held, so concurrent requests see each other's commitments here.
      await this.assertDepositCovers(maxGasCostWei, now);

      // 6. The registry must still resolve the paymaster to the relayer the proof names. A master that
      //    has unregistered this worker is read live here, not remembered from start-up.
      await this.assertRegistrationCurrent();

      // 7. On-chain sanity: the proof must verify against the instance right now.
      await this.assertWithdrawSimulates(w);

      // 8. Full simulation on the bundler (validation + execution incl. tail calls). Always.
      await this.assertBundlerSimulates(op, context);
    } catch (err) {
      this.sponsored.release(w.nullifierHash, token);
      throw err;
    }

    // 9. Sign.
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
    // 10. Record before issuing. A signature that could not be recorded is dropped here: a restart could
    //     otherwise sign the same note again while this one is still valid.
    try {
      this.sponsored.commit(w.nullifierHash, token);
    } catch (err) {
      this.sponsored.release(w.nullifierHash, token);
      throw new Error(`could not record the sponsorship, not issuing it: ${shortError(err)}`);
    }
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
      maxGasCostWei: maxGasCostWei.toString(),
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

  /**
   * One read of everything `/status` reports about the chain. A read that fails leaves its field
   * undefined and records the reason; nothing falls back to a start-up value or to zero.
   */
  private async liveState(now: number): Promise<{
    blockNumber?: bigint;
    deposit?: bigint;
    stake?: bigint;
    registry?: RegistryInfo;
    registrationCurrent: boolean;
    committed: ReturnType<typeof committedGasCost>;
    accepting: boolean;
    unavailable: Record<string, string>;
  }> {
    const unavailable: Record<string, string> = {};
    const attempt = async <T>(field: string, read: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await read();
      } catch (err) {
        unavailable[field] = shortError(err);
        return undefined;
      }
    };
    const [blockNumber, deposit, depositInfo, registry] = await Promise.all([
      attempt('checkedAtBlock', () => this.client.getBlockNumber()),
      attempt('deposit.wei', () => this.depositWei()),
      attempt('deposit.stakeWei', () =>
        this.client.readContract({
          address: this.config.entryPoint,
          abi: entryPointAbi,
          functionName: 'getDepositInfo',
          args: [this.config.paymaster],
        }),
      ),
      this.registry.mode === 'no-router'
        ? Promise.resolve(undefined)
        : attempt('registry', () =>
            probeRegistry(this.client, this.config.paymaster, this.registry.router, [...this.instances.keys()]),
          ),
    ]);
    const committed = committedGasCost(this.sponsored.outstanding(now), this.config.maxSponsorshipGasWei);
    if (!committed.known) {
      unavailable['deposit.committedWei'] =
        `${committed.unknown} restored sponsorships have no recorded gas cost until ${new Date(committed.until * 1000).toISOString()}`;
    }
    const floor = this.config.minDepositWei ?? 0n;
    const accepting = deposit !== undefined && committed.known && deposit >= committed.wei + floor;
    const registrationCurrent =
      this.registry.mode === 'no-router' || this.registry.mode === 'unregistered'
        ? true
        : !!registry && isAddressEqual(registry.master, this.rewardAccount);
    return {
      blockNumber,
      deposit,
      stake: depositInfo ? BigInt(depositInfo.stake) : undefined,
      registry,
      registrationCurrent,
      committed,
      accepting,
      unavailable,
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
   * The paymaster's own EntryPoint deposit, read now (not at start-up).
   */
  async depositWei(): Promise<bigint> {
    return this.client.readContract({ address: this.config.paymaster, abi: paymasterAbi, functionName: 'getDeposit' });
  }

  /**
   * The registry, read now, must resolve the paymaster to the relayer the proofs name (itself in master
   * mode, the master in worker mode). Otherwise `RelayerRegistry.burn` would revert inside the operation
   * — after the paymaster has paid for it. A registry that cannot be read is a refusal, not a pass.
   * Skipped only where there is nothing to check: no router, or a start-up that explicitly allowed an
   * unregistered paymaster.
   */
  private async assertRegistrationCurrent(): Promise<void> {
    if (this.registry.mode === 'no-router' || this.registry.mode === 'unregistered') return;
    let resolved: Address;
    try {
      resolved = await this.client.readContract({
        address: this.registry.relayerRegistry,
        abi: relayerRegistryAbi,
        functionName: 'workers',
        args: [this.config.paymaster],
      });
    } catch (err) {
      throw new ValidationError(`cannot read the relayer registry: ${shortError(err)}`, -32010);
    }
    if (!isAddressEqual(resolved, this.rewardAccount)) {
      throw new ValidationError(
        `the registry resolves paymaster ${this.config.paymaster} to ${resolved === zeroAddress ? 'no relayer' : resolved}, ` +
          `not ${this.rewardAccount}: not signing until the registration is restored`,
        -32010,
      );
    }
  }

  /**
   * Refuse the sponsorship unless the deposit covers this operation on top of every sponsorship that is
   * still live. The relayer does not move funds while it is serving: when this trips, top the deposit up
   * and requests are accepted again.
   */
  private async assertDepositCovers(maxGasCostWei: bigint, now: number): Promise<void> {
    const cap = this.config.maxSponsorshipGasWei;
    if (cap !== undefined && maxGasCostWei > cap) {
      throw new ValidationError(
        `this operation could cost ${maxGasCostWei} wei of gas, above the per-operation limit ${cap}`,
        -32004,
      );
    }
    const floor = this.config.minDepositWei ?? 0n;
    let deposit: bigint;
    try {
      deposit = await this.depositWei();
    } catch (err) {
      // An unreadable deposit is not a pass.
      throw new ValidationError(`cannot read the paymaster's EntryPoint deposit: ${shortError(err)}`, -32004);
    }
    // Everything already promised and not yet expired, including this request's own reservation.
    const budget = committedGasCost(this.sponsored.outstanding(now), cap);
    if (!budget.known) {
      throw new ValidationError(
        `${budget.unknown} live sponsorships restored from an earlier release have no recorded gas cost: ` +
          `not signing until they expire at ${new Date(budget.until * 1000).toISOString()} ` +
          '(or set MAX_SPONSORSHIP_GAS_WEI to budget them at that cap)',
        -32004,
      );
    }
    const committed = budget.wei;
    if (deposit < committed + floor) {
      throw new ValidationError(
        `paymaster deposit ${deposit} wei cannot cover ${committed} wei of live sponsorships plus the ${floor} wei reserve: ` +
          'the relayer is not accepting new sponsorships until the deposit is topped up',
        -32004,
      );
    }
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
    // Never a silent skip: a missing bundler URL is refused by `create`.
    if (!this.config.bundlerUrl) {
      throw new ValidationError('no bundler configured: refusing to sign without a pre-signing simulation', -32007);
    }
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
    let result: unknown;
    try {
      result = await this.bundlerRequest('eth_estimateUserOperationGas', [
        simulated,
        this.config.entryPoint,
        ...(stateOverride ? [stateOverride] : []),
      ]);
    } catch (err) {
      throw new ValidationError(`bundler simulation failed: ${shortError(err)}`, -32007);
    }

    // A transport that answers 200 with no usable estimate is a failed simulation, not a pass. The op
    // always has a paymaster here, so both paymaster gas fields are part of a usable estimate.
    const parsed = asGasEstimate(result, true);
    if (!parsed.ok) {
      throw new ValidationError(`bundler simulation returned no usable gas estimate: ${parsed.reason}`, -32007);
    }
    const estimate = parsed.estimate;
    // The op is signed with the limits the caller sent, so the estimate has to fit inside them. If it
    // does not, the caller re-quotes with the higher limits (and re-proves at the new fee) and asks
    // again — the relayer never edits an operation it has signed.
    const sent = readGas(op);
    const tooSmall: string[] = [];
    if (estimate.callGasLimit > sent.callGasLimit) tooSmall.push(`callGasLimit ${sent.callGasLimit} < ${estimate.callGasLimit}`);
    if (estimate.verificationGasLimit > sent.verificationGasLimit) {
      tooSmall.push(`verificationGasLimit ${sent.verificationGasLimit} < ${estimate.verificationGasLimit}`);
    }
    if (estimate.preVerificationGas > sent.preVerificationGas) {
      tooSmall.push(`preVerificationGas ${sent.preVerificationGas} < ${estimate.preVerificationGas}`);
    }
    if (estimate.paymasterVerificationGasLimit! > sent.paymasterVerificationGasLimit) {
      tooSmall.push(`paymasterVerificationGasLimit ${sent.paymasterVerificationGasLimit} < ${estimate.paymasterVerificationGasLimit}`);
    }
    // A postOp that runs out of gas reverts the whole execution after the paymaster has paid: the fee
    // transfer is undone with it.
    if (estimate.paymasterPostOpGasLimit! > sent.paymasterPostOpGasLimit) {
      tooSmall.push(`paymasterPostOpGasLimit ${sent.paymasterPostOpGasLimit} < ${estimate.paymasterPostOpGasLimit}`);
    }
    if (tooSmall.length > 0) {
      throw new ValidationError(
        `the bundler's estimate does not fit the operation's gas limits (${tooSmall.join('; ')}): re-quote with these limits and ask again`,
        -32008,
      );
    }
  }

  /**
   * One JSON-RPC call to the bundler. Every way it can fail — timeout, transport error, HTTP status,
   * unparseable body, JSON-RPC error, or a body with neither result nor error — throws, so a caller
   * that wraps this in a sponsorship check can never mistake a broken bundler for a passing simulation.
   */
  private async bundlerRequest(method: string, params: unknown[]): Promise<unknown> {
    const timeoutMs = this.config.bundlerTimeoutMs ?? 20_000;
    let res: Response;
    try {
      res = await fetch(this.config.bundlerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = (err as Error)?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : shortError(err);
      throw new Error(`${method}: ${reason}`);
    }
    if (!res.ok) throw new Error(`${method}: bundler returned HTTP ${res.status}`);
    let body: { result?: unknown; error?: { message?: string; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(`${method}: bundler returned a body that is not JSON`);
    }
    if (body?.error) {
      throw new Error((body.error.message ?? 'bundler error') + (body.error.data ? ` ${JSON.stringify(body.error.data)}` : ''));
    }
    if (!body || body.result === undefined || body.result === null) throw new Error(`${method}: bundler returned no result`);
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
    // Mandatory: `create` refuses an empty list, so this is always a real check.
    if (!this.config.allowedSenderImplementations.some((a) => isAddressEqual(a, implementation!))) {
      throw new ValidationError(
        `sender implementation ${implementation} (${source}) is not sponsored by this relayer`,
        -32009,
      );
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
    client.readContract({ address: relayerRegistry, abi: relayerRegistryAbi, functionName: 'feeManager' }),
  ]);
  // Every read here is required. A failed read is an error, never a zero fee: a zero from this function
  // must mean the FeeManager itself said zero.
  const burnPerWithdraw: Record<Address, bigint> = {};
  if (feeManager !== zeroAddress) {
    for (const instance of instances) {
      burnPerWithdraw[instance] = BigInt(
        await client.readContract({ address: feeManager, abi: feeManagerAbi, functionName: 'instanceFee', args: [instance] }),
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

export interface GasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  /** Present whenever the estimated op has a paymaster (`asGasEstimate(…, true)` requires both). */
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

/**
 * `eth_estimateUserOperationGas`'s result, when it really is one. Bundlers return hex quantities; a
 * body missing a required field, or carrying something that is not a quantity, is not an estimate and
 * must not be read as a successful simulation. For an op with a paymaster the two paymaster limits are
 * required too — Pimlico's bundler (and alto) return both for EntryPoint v0.7+.
 */
export function asGasEstimate(
  result: unknown,
  hasPaymaster: boolean,
): { ok: true; estimate: GasEstimate } | { ok: false; reason: string } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, reason: `not an object: ${JSON.stringify(result ?? null).slice(0, 120)}` };
  }
  const r = result as Record<string, unknown>;
  const quantity = (v: unknown): bigint | undefined => {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) return undefined;
    return hexToBigInt(v as Hex);
  };
  const required = ['callGasLimit', 'verificationGasLimit', 'preVerificationGas'];
  if (hasPaymaster) required.push('paymasterVerificationGasLimit', 'paymasterPostOpGasLimit');
  const values: Record<string, bigint> = {};
  for (const field of required) {
    const v = quantity(r[field]);
    if (v === undefined) {
      return { ok: false, reason: `${field} is ${r[field] === undefined ? 'missing' : `not a quantity (${JSON.stringify(r[field])})`}` };
    }
    values[field] = v;
  }
  return {
    ok: true,
    estimate: {
      callGasLimit: values.callGasLimit!,
      verificationGasLimit: values.verificationGasLimit!,
      preVerificationGas: values.preVerificationGas!,
      paymasterVerificationGasLimit: values.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: values.paymasterPostOpGasLimit,
    },
  };
}

/**
 * True when `err` is the contract itself reverting (or returning nothing), as opposed to the node or
 * the transport failing. Only the former may be read as an on-chain answer.
 */
export function isContractRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return !!err.walk(
    (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError || e instanceof ExecutionRevertedError,
  );
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
  // viem keeps the node's own words in `details`; the short message alone is often just
  // "An internal error was received."
  if (err instanceof BaseError) {
    return err.details && !err.shortMessage.includes(err.details) ? `${err.shortMessage} (${err.details})` : err.shortMessage;
  }
  if (err && typeof err === 'object' && 'shortMessage' in err) return String((err as { shortMessage: string }).shortMessage);
  return err instanceof Error ? err.message : String(err);
}
