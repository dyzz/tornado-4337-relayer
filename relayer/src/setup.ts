import {
  concatHex,
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  parseEther,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { entryPointAbi, paymasterAbi } from './abi.js';
import type { Logger } from './service.js';

export type PaymasterMode = 'standalone' | '7702';

export interface PaymasterSetupConfig {
  chainId: bigint;
  rpcUrl: string;
  entryPoint: Address;
  /** The relayer key. In 7702 mode it is also the paymaster address and the account that pays for setup. */
  signerKey: Hex;
  mode: PaymasterMode;
  /** Standalone: the deployed contract. 7702: defaults to the signer's own address. */
  paymaster?: Address;
  /** 7702: the shared per-chain `TornadoRelayerPaymaster7702` implementation to delegate to. */
  implementation?: Address;
  /** Send the delegation / stake / deposit transactions from the signer key when something is missing. */
  autoSetup: boolean;
  /** EntryPoint stake to keep (ERC-7562 lets a paymaster touch its own storage during validation only when staked). */
  stakeWei: bigint;
  unstakeDelaySec: number;
  /** Minimum EntryPoint deposit (gas float) to keep. */
  depositWei: bigint;
}

export const DEFAULT_STAKE_WEI = parseEther('0.1');
export const DEFAULT_UNSTAKE_DELAY_SEC = 86_400;

/** EIP-7702 delegation designator: 0xef0100 || implementation. */
export function delegationCode(implementation: Address): Hex {
  return concatHex(['0xef0100', implementation]).toLowerCase() as Hex;
}

/**
 * Bring the paymaster to a runnable state before the service starts:
 *   7702 mode  the signer EOA must be delegated to the implementation (one type-4 transaction the
 *              EOA sends to itself), staked and funded on the EntryPoint;
 *   standalone the contract must exist, and is topped up if the signer is allowed to.
 * With `autoSetup` off, anything missing is reported as an error with the exact step to take.
 */
export async function ensurePaymasterSetup(cfg: PaymasterSetupConfig, log: Logger): Promise<Address> {
  const account = privateKeyToAccount(cfg.signerKey);
  const chain = { id: Number(cfg.chainId), name: `chain-${cfg.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as const satisfies Chain;
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const paymaster = getAddress(cfg.mode === '7702' ? (cfg.paymaster ?? account.address) : cfg.paymaster!);

  if (cfg.mode === '7702') {
    if (!isAddressEqual(paymaster, account.address)) {
      throw new Error(`7702 mode: PAYMASTER_ADDRESS must be the signer's own address ${account.address}`);
    }
    if (!cfg.implementation || cfg.implementation === zeroAddress) {
      throw new Error('7702 mode needs PAYMASTER_IMPLEMENTATION (the TornadoRelayerPaymaster7702 deployment on this chain)');
    }
    const expected = delegationCode(cfg.implementation);
    const code = ((await publicClient.getCode({ address: account.address })) ?? '0x').toLowerCase();
    if (code !== expected) {
      const msg =
        `relayer address ${account.address} is not delegated to ${cfg.implementation} (code: ${code}). ` +
        'Send an EIP-7702 transaction from this key delegating to the implementation, or enable AUTO_SETUP.';
      if (!cfg.autoSetup) throw new Error(msg);
      log.info('7702: delegating the relayer address to the paymaster implementation', {
        address: account.address,
        implementation: cfg.implementation,
      });
      const nonce = await publicClient.getTransactionCount({ address: account.address });
      const authorization = await account.signAuthorization({
        address: cfg.implementation,
        chainId: Number(cfg.chainId),
        nonce: nonce + 1, // the EOA sends the transaction itself, so the authorization uses the next nonce
      });
      const hash = await wallet.sendTransaction({ to: account.address, data: '0x', authorizationList: [authorization] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`7702 delegation transaction ${hash} failed`);
      const after = ((await publicClient.getCode({ address: account.address })) ?? '0x').toLowerCase();
      if (after !== expected) throw new Error(`delegation did not take effect (code ${after})`);
      log.info('7702: delegated', { tx: hash });
    }
  } else {
    const code = (await publicClient.getCode({ address: paymaster })) ?? '0x';
    if (code === '0x') throw new Error(`no contract at PAYMASTER_ADDRESS ${paymaster}`);
  }

  // Stake (needed for validation-phase storage access under ERC-7562) and gas deposit.
  const info = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getDepositInfo', args: [paymaster] });
  const canAdmin = cfg.mode === '7702'; // standalone admin functions belong to the contract owner, not the relayer key
  if (cfg.stakeWei > 0n && (!info.staked || BigInt(info.stake) < cfg.stakeWei)) {
    const missing = cfg.stakeWei - BigInt(info.stake);
    const msg = `paymaster ${paymaster} has ${formatEther(BigInt(info.stake))} ETH staked on the EntryPoint, wants ${formatEther(cfg.stakeWei)}`;
    if (!cfg.autoSetup || !canAdmin) {
      log.warn(msg + (canAdmin ? '' : ' (call addStake from the owner key)'));
    } else {
      log.info('adding EntryPoint stake', { wei: missing.toString(), unstakeDelaySec: cfg.unstakeDelaySec });
      const hash = await wallet.writeContract({ address: paymaster, abi: paymasterAbi, functionName: 'addStake', args: [cfg.unstakeDelaySec], value: missing });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }
  if (info.deposit < cfg.depositWei) {
    const missing = cfg.depositWei - info.deposit;
    if (!cfg.autoSetup) {
      log.warn(`paymaster deposit ${formatEther(info.deposit)} ETH is below the configured ${formatEther(cfg.depositWei)} ETH`);
    } else {
      log.info('topping up the EntryPoint deposit', { wei: missing.toString() });
      const hash = await wallet.writeContract({ address: paymaster, abi: paymasterAbi, functionName: 'deposit', value: missing });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }
  return paymaster;
}
