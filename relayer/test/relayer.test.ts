import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';

import { baseAccountAbi, tornadoInstanceAbi } from '../src/abi.js';
import { DEFAULT_GAS, minimumFee, serviceFeeFor } from '../src/fee.js';
import { encodePaymasterData, DUMMY_SIGNATURE, packInitCode, readGas, totalGas } from '../src/userop.js';
import { decodeAccountCalls, findSponsoringWithdraw, ValidationError } from '../src/validate.js';

const INSTANCE: Address = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc';
const PAYMASTER: Address = '0x000000000000000000000000000000000000dEaD';
const SENDER: Address = '0x1111111111111111111111111111111111111111';

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
          { target: INSTANCE, value: 0n, data: withdrawData('0x0000000000000000000000000000000000000000', 0n, `0x${'02'.repeat(32)}`) },
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
  it('minimum fee = prefund * (1 + margin) + service fee', () => {
    const gas = DEFAULT_GAS;
    const maxFeePerGas = 2_000_000_000n;
    const serviceFee = serviceFeeFor(parseEther('0.1'), 30n);
    expect(serviceFee).toBe(parseEther('0.0003'));
    const prefund = totalGas(gas) * maxFeePerGas;
    expect(minimumFee({ gas, maxFeePerGas, gasMarginBps: 1_000n, serviceFee })).toBe(
      prefund + prefund / 10n + serviceFee,
    );
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

  it('encodes 161 bytes of paymasterData', () => {
    const data = encodePaymasterData(
      { validUntil: 1, validAfter: 0, fee: 1n, serviceFee: 1n, refundTo: SENDER },
      DUMMY_SIGNATURE,
    );
    expect((data.length - 2) / 2).toBe(6 + 6 + 32 + 32 + 20 + 65);
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
