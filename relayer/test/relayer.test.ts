import { describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, parseEther, zeroAddress, type Address, type Hex } from 'viem';

import { baseAccountAbi, paymasterAbi, tornadoInstanceAbi } from '../src/abi.js';
import { DEFAULT_GAS, minimumFee, serviceFeeFor } from '../src/fee.js';
import { FixedPriceSource, parseDecimal, weiPerTokenFrom } from '../src/price.js';
import { encodePaymasterData, DUMMY_SIGNATURE, EIP7702_INITCODE_MARKER, initCodeHash, isEip7702InitCode, packInitCode, paymasterHash, readGas, totalGas } from '../src/userop.js';
import { decodeAccountCalls, findSponsoringWithdraw, ValidationError } from '../src/validate.js';
import { asGasEstimate, committedGasCost, MemorySponsorshipStore, type SponsoredNote } from '../src/service.js';
import { FileSponsorshipStore } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTANCE: Address = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc';
const PAYMASTER: Address = '0x000000000000000000000000000000000000dEaD';
const SENDER: Address = '0x1111111111111111111111111111111111111111';
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const MASTER: Address = '0x2222222222222222222222222222222222222222';

/** Direct `pool.withdraw` (the non-sponsoring notes of a consolidation batch). */
function withdrawData(relayer: Address, fee: bigint, nullifierHash: Hex = `0x${'01'.repeat(32)}`): Hex {
  return encodeFunctionData({
    abi: tornadoInstanceAbi,
    functionName: 'withdraw',
    args: [`0x${'aa'.repeat(256)}`, `0x${'00'.repeat(32)}`, nullifierHash, SENDER, relayer, fee, 0n],
  });
}

/** `paymaster.relayWithdraw` (the sponsoring note, routed through TornadoRouter on-chain). */
function relayData(
  relayer: Address,
  fee: bigint,
  { instance = INSTANCE, recipient = SENDER, nullifierHash = `0x${'01'.repeat(32)}` as Hex } = {},
): Hex {
  return encodeFunctionData({
    abi: paymasterAbi,
    functionName: 'relayWithdraw',
    args: [instance, `0x${'aa'.repeat(256)}`, `0x${'00'.repeat(32)}`, nullifierHash, recipient, relayer, fee],
  });
}

const rules = (rewardAccount: Address = PAYMASTER) => ({
  paymaster: PAYMASTER,
  rewardAccount,
  allowedInstances: [INSTANCE],
  sender: SENDER,
});
const single = (target: Address, value: bigint, data: Hex) =>
  decodeAccountCalls(encodeFunctionData({ abi: baseAccountAbi, functionName: 'execute', args: [target, value, data] }));

describe('validate', () => {
  it('finds the sponsoring relayWithdraw in an executeBatch with tail calls', () => {
    const callData = encodeFunctionData({
      abi: baseAccountAbi,
      functionName: 'executeBatch',
      args: [
        [
          { target: PAYMASTER, value: 0n, data: relayData(PAYMASTER, 123n) },
          { target: SENDER, value: 1n, data: '0x' },
        ],
      ],
    });
    const calls = decodeAccountCalls(callData);
    expect(calls).toHaveLength(2);
    const w = findSponsoringWithdraw(calls, rules());
    expect(w.index).toBe(0);
    expect(w.via).toBe('paymaster');
    expect(w.instance).toBe(INSTANCE);
    expect(w.fee).toBe(123n);
    expect(w.relayer).toBe(PAYMASTER);
    expect(w.refund).toBe(0n);
  });

  it('accepts a single execute(...) call and worker mode (relayer = master EOA)', () => {
    expect(findSponsoringWithdraw(single(PAYMASTER, 0n, relayData(PAYMASTER, 5n)), rules()).fee).toBe(5n);
    expect(findSponsoringWithdraw(single(PAYMASTER, 0n, relayData(MASTER, 7n)), rules(MASTER)).relayer).toBe(MASTER);
    // Master mode must not accept a proof that pays some other address.
    expect(() => findSponsoringWithdraw(single(PAYMASTER, 0n, relayData(MASTER, 7n)), rules())).toThrow(/must name/);
  });

  it('rejects direct pool withdraws as the sponsoring call (they bypass the Router / TORN burn)', () => {
    expect(() => findSponsoringWithdraw(single(INSTANCE, 0n, withdrawData(PAYMASTER, 5n)), rules())).toThrow(
      /no relayWithdraw/,
    );
  });

  it('rejects wrong recipient, unknown instances, value, other paymaster calls and duplicate payers', () => {
    expect(() =>
      findSponsoringWithdraw(single(PAYMASTER, 0n, relayData(PAYMASTER, 5n, { recipient: MASTER })), rules()),
    ).toThrow(/recipient must be the userOp sender/);
    expect(() =>
      findSponsoringWithdraw(single(PAYMASTER, 0n, relayData(PAYMASTER, 5n, { instance: SENDER })), rules()),
    ).toThrow(/not served/);
    expect(() => findSponsoringWithdraw(single(PAYMASTER, 1n, relayData(PAYMASTER, 5n)), rules())).toThrow(/value/);
    expect(() => findSponsoringWithdraw(single(INSTANCE, 0n, withdrawData(SENDER, 5n)), rules())).toThrow(ValidationError);

    const sweepData = encodeFunctionData({
      abi: [{ type: 'function', name: 'sweep', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'sweep',
      args: [SENDER, 1n],
    });
    const batch = (calls: { target: Address; value: bigint; data: Hex }[]) =>
      decodeAccountCalls(encodeFunctionData({ abi: baseAccountAbi, functionName: 'executeBatch', args: [calls] }));
    expect(() =>
      findSponsoringWithdraw(
        batch([
          { target: PAYMASTER, value: 0n, data: relayData(PAYMASTER, 5n) },
          { target: PAYMASTER, value: 0n, data: sweepData },
        ]),
        rules(),
      ),
    ).toThrow(/only relayWithdraw/);
    // A second note withdrawn directly would ride on the sponsored gas without a router burn.
    expect(() =>
      findSponsoringWithdraw(
        batch([
          { target: PAYMASTER, value: 0n, data: relayData(PAYMASTER, 5n) },
          { target: INSTANCE, value: 0n, data: withdrawData(zeroAddress, 0n, `0x${'03'.repeat(32)}`) },
        ]),
        rules(),
      ),
    ).toThrow(/one Tornado withdrawal per operation/);
    expect(() =>
      findSponsoringWithdraw(
        batch([
          { target: PAYMASTER, value: 0n, data: relayData(PAYMASTER, 5n) },
          { target: PAYMASTER, value: 0n, data: relayData(PAYMASTER, 5n, { nullifierHash: `0x${'04'.repeat(32)}` }) },
        ]),
        rules(),
      ),
    ).toThrow(/one Tornado withdrawal per operation/);

    expect(() => decodeAccountCalls('0xdeadbeef')).toThrow(ValidationError);
  });
});

describe('fee', () => {
  it('ETH: minimum fee = prefund * (1 + margin) + service fee', () => {
    const gas = DEFAULT_GAS;
    const maxFeePerGas = 2_000_000_000n;
    const serviceFee = serviceFeeFor(parseEther('0.1'), 30n);
    expect(serviceFee).toBe(parseEther('0.0003'));
    const prefund = totalGas(gas) * maxFeePerGas;
    expect(minimumFee({ gas, maxFeePerGas, gasMarginBps: 1_000n, serviceFee })).toBe(
      prefund + prefund / 10n + serviceFee,
    );
  });

  it('ERC-20: converts the ETH cost at tokenPerEth (rounding up) and adds the token service fee', () => {
    const gas = DEFAULT_GAS;
    const maxFeePerGas = 2_000_000_000n;
    const tokenPerEth = 3000n * 10n ** 18n; // 3000 DAI / ETH
    const serviceFee = serviceFeeFor(100n * 10n ** 18n, 30n); // 0.3 DAI
    const prefund = totalGas(gas) * maxFeePerGas;
    const keepEth = prefund + prefund / 10n;
    const keepDai = (keepEth * tokenPerEth + 10n ** 18n - 1n) / 10n ** 18n;
    expect(minimumFee({ gas, maxFeePerGas, gasMarginBps: 1_000n, serviceFee, tokenPerEth })).toBe(keepDai + serviceFee);
  });
});

describe('price', () => {
  it('fixed source: whole tokens per ETH -> base units, and back to wei per token', async () => {
    const src = new FixedPriceSource({ [DAI]: '3000', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': '0.03' });
    expect(await src.tokenPerEth(DAI, 18)).toBe(3000n * 10n ** 18n);
    expect(await src.tokenPerEth('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8)).toBe(3_000_000n); // 0.03 WBTC
    expect(weiPerTokenFrom(3000n * 10n ** 18n, 18)).toBe(10n ** 18n / 3000n);
    expect(parseDecimal('1.5', 6)).toBe(1_500_000n);
    await expect(src.tokenPerEth(SENDER, 18)).rejects.toThrow(/no fixed price/);
  });
});

describe('userop', () => {
  it('packs initCode per EntryPoint v0.8 (20-byte 0x7702 marker for EIP-7702 senders)', () => {
    expect(packInitCode({ sender: SENDER, callData: '0x' } as never)).toBe('0x');
    expect(packInitCode({ sender: SENDER, callData: '0x', factory: '0x7702', factoryData: '0x' } as never)).toBe(EIP7702_INITCODE_MARKER);
    expect(
      packInitCode({ sender: SENDER, callData: '0x', factory: SENDER, factoryData: '0xabcd' } as never),
    ).toBe(`${SENDER.toLowerCase()}abcd`);
    expect(isEip7702InitCode('0x7702')).toBe(true);
    expect(isEip7702InitCode(EIP7702_INITCODE_MARKER)).toBe(true);
    expect(isEip7702InitCode(`${EIP7702_INITCODE_MARKER}abcd`)).toBe(true);
    expect(isEip7702InitCode('0x77020001')).toBe(false);
    expect(isEip7702InitCode(SENDER)).toBe(false);
  });

  it('hashes an EIP-7702 op identically however the bundler spells the marker (delegate ‖ factoryData, like the EntryPoint)', () => {
    const base = {
      sender: SENDER,
      nonce: '0x5',
      callData: '0xdeadbeef',
      callGasLimit: '0x186a0',
      verificationGasLimit: '0x30d40',
      preVerificationGas: '0x7530',
      maxFeePerGas: '0x3b9aca00',
      maxPriorityFeePerGas: '0x1',
      paymasterVerificationGasLimit: '0xea60',
      paymasterPostOpGasLimit: '0x15f90',
    } as const;
    const terms = {
      validUntil: 1, validAfter: 0, fee: 1n, serviceFee: 1n, refundTo: SENDER, feeToken: DAI, tokenPerEth: 5n,
      withdrawalHash: `0x${'ab'.repeat(32)}` as Hex, senderImplementation: MASTER,
    };
    const hashOf = (extra: object) => paymasterHash({ op: { ...base, ...extra } as never, chainId: 1n, paymaster: PAYMASTER, terms });
    const viemForm = hashOf({ factory: '0x7702', factoryData: '0x' });
    expect(hashOf({ initCode: '0x7702' })).toBe(viemForm);
    expect(hashOf({ initCode: EIP7702_INITCODE_MARKER })).toBe(viemForm);
    expect(initCodeHash({ ...base, initCode: '0x7702' } as never, MASTER)).toBe(keccak256(MASTER));
    expect(initCodeHash({ ...base, initCode: `${EIP7702_INITCODE_MARKER}abcd` } as never, MASTER)).toBe(keccak256(`${MASTER}abcd`));
    // Not an EIP-7702 op: plain keccak of the (empty) initCode, whatever the terms say.
    expect(hashOf({})).not.toBe(viemForm);
    expect(initCodeHash({ ...base } as never, undefined)).toBe(keccak256('0x'));
    expect(() => initCodeHash({ ...base, initCode: '0x7702' } as never, undefined)).toThrow(/sender implementation/);
  });

  it('encodes 265 bytes of paymasterData (317 with the EntryPoint prefix)', () => {
    const data = encodePaymasterData(
      { validUntil: 1, validAfter: 0, fee: 1n, serviceFee: 1n, refundTo: SENDER, feeToken: DAI, tokenPerEth: 5n, withdrawalHash: `0x${'ab'.repeat(32)}`, senderImplementation: MASTER },
      DUMMY_SIGNATURE,
    );
    expect((data.length - 2) / 2).toBe(6 + 6 + 32 + 32 + 20 + 20 + 32 + 32 + 20 + 65);
    expect(data.slice(2 + 2 * (6 + 6 + 32 + 32 + 20), 2 + 2 * (6 + 6 + 32 + 32 + 20 + 20))).toBe(DAI.slice(2).toLowerCase());
  });

  it('reads gas fields with zero defaults for the paymaster limits', () => {
    const gas = readGas({
      sender: SENDER,
      callData: '0x',
      nonce: '0x0',
      callGasLimit: '0x10',
      verificationGasLimit: '0x20',
      preVerificationGas: '0x30',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
    });
    expect(gas).toEqual({
      callGasLimit: 16n,
      verificationGasLimit: 32n,
      preVerificationGas: 48n,
      paymasterVerificationGasLimit: 0n,
      paymasterPostOpGasLimit: 0n,
    });
  });
});

describe('sponsorship store', () => {
  const NH: Hex = `0x${'aa'.repeat(32)}`;
  // maxGasCostWei is what the deposit budget counts, and it is a bigint: the file store has to write it
  // as a string and read it back, so the fixtures carry it.
  const a = { validUntil: 2_000_000_000, sender: SENDER, nonce: 0n, maxGasCostWei: 12_345_678_901n };
  const b = { validUntil: 2_000_000_000, sender: MASTER, nonce: 0n, maxGasCostWei: 99n };

  it('reserve is check-and-set; a failed request releases only its own pending entry', () => {
    const store = new MemorySponsorshipStore();
    const r1 = store.reserve(NH, a);
    expect(r1.ok).toBe(true);
    expect(store.reserve(NH, b).ok).toBe(false); // concurrent request for the same note
    expect(store.reserve(NH, a).ok).toBe(false); // even the same sender: one request at a time
    store.release(NH, 'someone-else');
    expect(store.get(NH)?.status).toBe('pending');
    store.release(NH, (r1 as { token: string }).token);
    expect(store.get(NH)).toBeUndefined();
  });

  it('a signed sponsorship survives a later failed retry of the same sender and nonce', () => {
    const store = new MemorySponsorshipStore();
    const first = store.reserve(NH, a) as { ok: true; token: string };
    store.commit(NH, first.token);
    expect(store.get(NH)?.status).toBe('signed');
    // Retry of the same sender/nonce: refused (the client already holds a valid signature) …
    const retry = store.reserve(NH, a);
    expect(retry.ok).toBe(false);
    expect((retry as { held: { status: string } }).held.status).toBe('signed');
    // … and even a mistaken release with a foreign or stale token cannot drop the signed entry.
    store.release(NH, first.token);
    store.release(NH, 'stale');
    expect(store.get(NH)?.status).toBe('signed');
    expect(store.reserve(NH, b).ok).toBe(false);
    store.prune(2_000_000_001);
    expect(store.reserve(NH, b).ok).toBe(true);
  });

  it('file store: a signed entry survives a restart with every bigint intact, and still dedups and budgets', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sponsor-')), 'sponsorships.json');
    const first = new FileSponsorshipStore(file, 1_000);
    const r = first.reserve(NH, a) as { ok: true; token: string };
    first.commit(NH, r.token);

    const restarted = new FileSponsorshipStore(file, 1_000);
    expect(restarted.legacyEntries).toBe(0);
    const note = restarted.get(NH)!;
    expect(note.status).toBe('signed');
    expect(note.sender).toBe(SENDER);
    expect(note.nonce).toBe(0n);
    expect(note.maxGasCostWei).toBe(a.maxGasCostWei);
    // Still one sponsorship per note after the restart …
    expect(restarted.reserve(NH, b).ok).toBe(false);
    // … and still counted against the deposit.
    expect(committedGasCost(restarted.outstanding(1_000))).toEqual({ known: true, wei: a.maxGasCostWei });
    // Written as decimal strings.
    expect(JSON.parse(readFileSync(file, 'utf8'))[NH]).toMatchObject({ nonce: '0', maxGasCostWei: a.maxGasCostWei.toString() });
  });

  it('file store: a reservation is never written; only a commit reaches the disk', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sponsor-')), 'sponsorships.json');
    const store = new FileSponsorshipStore(file, 1_000);
    const r = store.reserve(NH, a) as { ok: true; token: string };
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
    expect(new FileSponsorshipStore(file, 1_000).get(NH)).toBeUndefined();
    store.release(NH, r.token);
    expect(store.get(NH)).toBeUndefined();
  });

  it('file store: a failed write leaves no pending entry behind and the note free for the next request', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sponsor-')), 'sponsorships.json');
    const store = new FileSponsorshipStore(file, 1_000);
    const r = store.reserve(NH, a) as { ok: true; token: string };
    // Make the write fail for real: the temporary path is now a directory.
    mkdirSync(`${file}.tmp`);
    expect(() => store.commit(NH, r.token)).toThrow();
    // Nothing changed: not signed in memory, not on disk.
    expect(store.get(NH)?.status).toBe('pending');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
    // The signing path releases the reservation it could not record (RelayerService.sign does this).
    store.release(NH, r.token);
    expect(store.get(NH)).toBeUndefined();
    expect(store.outstanding(1_000)).toEqual([]);
    // Once the disk is writable again the same note can be sponsored.
    rmdirSync(`${file}.tmp`);
    const again = store.reserve(NH, b) as { ok: true; token: string };
    expect(again.ok).toBe(true);
    store.commit(NH, again.token);
    expect(new FileSponsorshipStore(file, 1_000).get(NH)?.sender).toBe(MASTER);
  });

  it('file store: refuses to start on a file it cannot trust or a location it cannot write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sponsor-'));
    const garbage = join(dir, 'garbage.json');
    writeFileSync(garbage, '{ not json');
    expect(() => new FileSponsorshipStore(garbage)).toThrow();
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, JSON.stringify({ [NH]: { status: 'signed', validUntil: 'soon', nonce: '0', sender: SENDER } }));
    expect(() => new FileSponsorshipStore(malformed)).toThrow(/malformed entry/);
    // A path under a regular file cannot be created: start-up fails instead of the first request.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(() => new FileSponsorshipStore(join(blocker, 'sponsorships.json'))).toThrow();
  });

  it('file store: entries from an earlier release keep their dedup, and their unknown cost is never counted as zero', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sponsor-')), 'sponsorships.json');
    const OTHER: Hex = `0x${'bb'.repeat(32)}`;
    const PENDING: Hex = `0x${'cc'.repeat(32)}`;
    // The format written before the deposit budget: no maxGasCostWei, pending entries included.
    writeFileSync(
      file,
      JSON.stringify({
        [NH]: { validUntil: 2_000, sender: SENDER, nonce: '3', status: 'signed', token: 't1' },
        [OTHER]: { validUntil: 500, sender: SENDER, nonce: '4', status: 'signed', token: 't2' }, // expired
        [PENDING]: { validUntil: 2_000, sender: SENDER, nonce: '5', status: 'pending', token: 't3' },
      }),
    );
    const store = new FileSponsorshipStore(file, 1_000);
    expect(store.legacyEntries).toBe(1);
    expect(store.get(NH)?.nonce).toBe(3n);
    expect(store.get(NH)?.maxGasCostWei).toBeUndefined();
    expect(store.get(OTHER)).toBeUndefined();
    expect(store.get(PENDING)).toBeUndefined();
    expect(store.reserve(NH, a).ok).toBe(false);
    // Without a per-operation cap the budget is unknown until the entry expires …
    expect(committedGasCost(store.outstanding(1_000))).toEqual({ known: false, unknown: 1, until: 2_000 });
    // … with one, the entry is budgeted at the cap.
    expect(committedGasCost(store.outstanding(1_000), 7n)).toEqual({ known: true, wei: 7n });
    // After it expires the budget is known again.
    store.prune(2_001);
    expect(committedGasCost(store.outstanding(2_001))).toEqual({ known: true, wei: 0n });
    // The rewrite at start-up dropped the expired and the pending entry.
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual([NH]);
  });

  it('commit refuses a reservation the request no longer holds', () => {
    const store = new MemorySponsorshipStore();
    const r = store.reserve(NH, a) as { ok: true; token: string };
    expect(() => store.commit(NH, 'not-the-holder')).toThrow(/no longer held/);
    store.prune(2_000_000_001);
    expect(() => store.commit(NH, r.token)).toThrow(/no longer held/);
    expect(store.get(NH)).toBeUndefined();
  });

  it('outstanding() counts live sponsorships and forgets expired ones', () => {
    const store = new MemorySponsorshipStore();
    const r = store.reserve(NH, a) as { ok: true; token: string };
    // A pending reservation already counts: it may still become a signature.
    expect(store.outstanding(1_000).map((n) => n.maxGasCostWei)).toEqual([a.maxGasCostWei]);
    store.commit(NH, r.token);
    expect(store.outstanding(1_000).map((n) => n.status)).toEqual(['signed']);
    // Past its validUntil it is nobody's liability any more.
    expect(store.outstanding(2_000_000_001)).toEqual([]);
  });

  it('committedGasCost sums known costs and budgets unknown ones only at an explicit cap', () => {
    const note = (validUntil: number, maxGasCostWei?: bigint): SponsoredNote => ({
      validUntil,
      sender: SENDER,
      nonce: 0n,
      status: 'signed',
      token: 't',
      maxGasCostWei,
    });
    expect(committedGasCost([])).toEqual({ known: true, wei: 0n });
    expect(committedGasCost([note(10, 3n), note(10, 4n)])).toEqual({ known: true, wei: 7n });
    expect(committedGasCost([note(10, 3n), note(20), note(15)])).toEqual({ known: false, unknown: 2, until: 20 });
    expect(committedGasCost([note(10, 3n), note(20)], 100n)).toEqual({ known: true, wei: 103n });
  });
});

describe('bundler estimate', () => {
  const full = {
    callGasLimit: '0x10',
    verificationGasLimit: '0x20',
    preVerificationGas: '0x30',
    paymasterVerificationGasLimit: '0x40',
    paymasterPostOpGasLimit: '0x50',
  };

  it('parses a complete estimate', () => {
    expect(asGasEstimate(full, true)).toEqual({
      ok: true,
      estimate: {
        callGasLimit: 16n,
        verificationGasLimit: 32n,
        preVerificationGas: 48n,
        paymasterVerificationGasLimit: 64n,
        paymasterPostOpGasLimit: 80n,
      },
    });
  });

  it('requires both paymaster limits for an op with a paymaster, and says which one is missing', () => {
    const { paymasterPostOpGasLimit: _, ...noPostOp } = full;
    expect(asGasEstimate(noPostOp, true)).toEqual({ ok: false, reason: 'paymasterPostOpGasLimit is missing' });
    const { paymasterVerificationGasLimit: __, ...noVerif } = full;
    expect(asGasEstimate(noVerif, true)).toMatchObject({ ok: false, reason: 'paymasterVerificationGasLimit is missing' });
    // Without a paymaster they are not part of the estimate.
    expect(asGasEstimate(noPostOp, false).ok).toBe(true);
  });

  it('rejects bodies that are not estimates', () => {
    expect(asGasEstimate(null, true).ok).toBe(false);
    expect(asGasEstimate([], true).ok).toBe(false);
    expect(asGasEstimate({ ok: true }, true)).toMatchObject({ ok: false, reason: 'callGasLimit is missing' });
    expect(asGasEstimate({ ...full, callGasLimit: 'lots' }, true)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a quantity/) });
    expect(asGasEstimate({ ...full, preVerificationGas: -1 }, true).ok).toBe(false);
  });
});

describe('config', () => {
  const base = {
    RELAYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    CHAIN_ID: '11155111',
    RPC_URL: 'http://127.0.0.1:1',
    BUNDLER_URL: 'http://127.0.0.1:2',
    TORNADO_INSTANCES: INSTANCE,
  };
  const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
    const saved = { ...process.env };
    for (const k of ['SIMULATE_WITH_BUNDLER', 'ALLOWED_SENDER_IMPLEMENTATIONS', 'SPONSORSHIP_STORE', 'BUNDLER_URL', 'PRICE_SOURCE']) delete process.env[k];
    Object.assign(process.env, base);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };

  it('defaults the sponsored implementations to Simple7702Account and never to "any"', () => {
    expect(withEnv({}, () => configFromEnv(PAYMASTER).allowedSenderImplementations)).toEqual([
      '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
    ]);
    expect(() => withEnv({ ALLOWED_SENDER_IMPLEMENTATIONS: '' }, () => configFromEnv(PAYMASTER))).toThrow(/empty/);
    expect(() => withEnv({ ALLOWED_SENDER_IMPLEMENTATIONS: ' , ' }, () => configFromEnv(PAYMASTER))).toThrow(/empty/);
  });

  it('cannot switch the pre-signing simulation off, and needs a bundler', () => {
    expect(() => withEnv({ SIMULATE_WITH_BUNDLER: 'false' }, () => configFromEnv(PAYMASTER))).toThrow(/cannot be disabled/);
    expect(() => withEnv({ SIMULATE_WITH_BUNDLER: '0' }, () => configFromEnv(PAYMASTER))).toThrow(/cannot be disabled/);
    // Older .env files that say `true` keep working.
    expect(withEnv({ SIMULATE_WITH_BUNDLER: 'true' }, () => configFromEnv(PAYMASTER)).bundlerUrl).toBe(base.BUNDLER_URL);
    expect(() => withEnv({ BUNDLER_URL: undefined }, () => configFromEnv(PAYMASTER))).toThrow(/BUNDLER_URL/);
  });

  it('opens the sponsorship store at configuration time, so an unusable one stops the start-up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sponsor-'));
    const ok = join(dir, 'nested', 'sponsorships.json');
    expect(withEnv({ SPONSORSHIP_STORE: ok }, () => configFromEnv(PAYMASTER)).sponsorshipStore).toBeDefined();
    expect(existsSync(ok)).toBe(true);
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(() => withEnv({ SPONSORSHIP_STORE: join(blocker, 'x.json') }, () => configFromEnv(PAYMASTER))).toThrow();
  });
});
