import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther, zeroAddress, type Address, type Hex } from 'viem';

import { baseAccountAbi, tornadoInstanceAbi } from '../src/abi.js';
import { DEFAULT_GAS, minimumFee, serviceFeeFor } from '../src/fee.js';
import { FixedPriceSource, parseDecimal, weiPerTokenFrom } from '../src/price.js';
import { encodePaymasterData, DUMMY_SIGNATURE, packInitCode, readGas, totalGas } from '../src/userop.js';
import { decodeAccountCalls, findSponsoringWithdraw, ValidationError } from '../src/validate.js';

const INSTANCE: Address = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc';
const PAYMASTER: Address = '0x000000000000000000000000000000000000dEaD';
const SENDER: Address = '0x1111111111111111111111111111111111111111';
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

function withdrawData(relayer: Address, fee: bigint, nullifierHash: Hex = `0x${'01'.repeat(32)}`): Hex {
  return encodeFunctionData({
    abi: tornadoInstanceAbi,
    functionName: 'withdraw',
    args: [`0x${'aa'.repeat(256)}`, `0x${'00'.repeat(32)}`, nullifierHash, SENDER, relayer, fee, 0n],
  });
}

describe('validate', () => {
  it('finds the sponsoring withdraw in an executeBatch with extra withdraws and tail calls', () => {
    const callData = encodeFunctionData({
      abi: baseAccountAbi,
      functionName: 'executeBatch',
      args: [
        [
          { target: INSTANCE, value: 0n, data: withdrawData(PAYMASTER, 123n) },
          { target: INSTANCE, value: 0n, data: withdrawData(zeroAddress, 0n, `0x${'02'.repeat(32)}`) },
          { target: SENDER, value: 1n, data: '0x' },
        ],
      ],
    });
    const calls = decodeAccountCalls(callData);
    expect(calls).toHaveLength(3);
    const w = findSponsoringWithdraw(calls, PAYMASTER, [INSTANCE]);
    expect(w.index).toBe(0);
    expect(w.fee).toBe(123n);
    expect(w.relayer).toBe(PAYMASTER);
  });

  it('accepts a single execute(...) call', () => {
    const callData = encodeFunctionData({
      abi: baseAccountAbi,
      functionName: 'execute',
      args: [INSTANCE, 0n, withdrawData(PAYMASTER, 5n)],
    });
    const w = findSponsoringWithdraw(decodeAccountCalls(callData), PAYMASTER, [INSTANCE]);
    expect(w.fee).toBe(5n);
  });

  it('rejects when no withdraw pays the paymaster, unknown instances, and value-carrying withdraws', () => {
    const noPay = encodeFunctionData({
      abi: baseAccountAbi,
      functionName: 'execute',
      args: [INSTANCE, 0n, withdrawData(SENDER, 5n)],
    });
    expect(() => findSponsoringWithdraw(decodeAccountCalls(noPay), PAYMASTER, [INSTANCE])).toThrow(ValidationError);

    const unknown = encodeFunctionData({
      abi: baseAccountAbi,
      functionName: 'execute',
      args: [SENDER, 0n, withdrawData(PAYMASTER, 5n)],
    });
    expect(() => findSponsoringWithdraw(decodeAccountCalls(unknown), PAYMASTER, [INSTANCE])).toThrow(/not served/);

    const withValue = encodeFunctionData({
      abi: baseAccountAbi,
      functionName: 'execute',
      args: [INSTANCE, 1n, withdrawData(PAYMASTER, 5n)],
    });
    expect(() => findSponsoringWithdraw(decodeAccountCalls(withValue), PAYMASTER, [INSTANCE])).toThrow(/value/);

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
  it('packs initCode like viem (0x7702 marker for EIP-7702 senders)', () => {
    expect(packInitCode({ sender: SENDER, callData: '0x' } as never)).toBe('0x');
    expect(packInitCode({ sender: SENDER, callData: '0x', factory: '0x7702', factoryData: '0x' } as never)).toBe('0x7702');
    expect(
      packInitCode({ sender: SENDER, callData: '0x', factory: SENDER, factoryData: '0xabcd' } as never),
    ).toBe(`${SENDER.toLowerCase()}abcd`);
  });

  it('encodes 213 bytes of paymasterData (265 with the EntryPoint prefix)', () => {
    const data = encodePaymasterData(
      { validUntil: 1, validAfter: 0, fee: 1n, serviceFee: 1n, refundTo: SENDER, feeToken: DAI, tokenPerEth: 5n },
      DUMMY_SIGNATURE,
    );
    expect((data.length - 2) / 2).toBe(6 + 6 + 32 + 32 + 20 + 20 + 32 + 65);
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
