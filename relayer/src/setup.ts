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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { entryPointAbi, paymasterAbi, relayerRegistryAbi, tornadoRouterAbi } from './abi.js';
import { paymasterArtifact } from './generated/paymaster-artifact.js';
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
  /** Standalone: DAO TornadoRouter to wire into a freshly deployed contract (0 = call pools directly). */
  router?: Address;
  /** Standalone: gas parameters of a freshly deployed contract. */
  gasMarginBps?: bigint;
  postOpGasOverhead?: bigint;
  /** Standalone: where the address of a self-deployed contract is remembered across restarts. */
  stateFile?: string;
  /** The relayer master the paymaster must be a worker of (or the paymaster itself in master mode). */
  rewardAccount?: Address;
  /** Gate start-up on the registry: refuse (or wait) until the paymaster is registered under `rewardAccount`. */
  requireRegistration?: boolean;
  /** Poll the registry until the master has registered the paymaster instead of exiting. */
  waitForRegistration?: boolean;
}

export const DEFAULT_STAKE_WEI = parseEther('0.1');
export const DEFAULT_UNSTAKE_DELAY_SEC = 86_400;

/** EIP-7702 delegation designator: 0xef0100 || implementation. */
export function delegationCode(implementation: Address): Hex {
  return concatHex(['0xef0100', implementation]).toLowerCase() as Hex;
}

interface StateFile {
  paymaster?: Address;
  deployTx?: Hex;
}

/**
 * Bring the paymaster to a runnable state before the service starts:
 *   standalone the worker contract (`TornadoRelayerPaymaster`, owner = the relayer key) is deployed by the
 *              service itself on first start and remembered in `stateFile`; then staked and funded; then the
 *              service waits until the relayer's master has registered it as a worker;
 *   7702       the signer EOA must be delegated to the implementation (one type-4 transaction the EOA sends
 *              to itself), staked and funded on the EntryPoint.
 * With `autoSetup` off, anything missing is reported as an error with the exact step to take.
 */
export async function ensurePaymasterSetup(cfg: PaymasterSetupConfig, log: Logger): Promise<Address> {
  const account = privateKeyToAccount(cfg.signerKey);
  const chain = { id: Number(cfg.chainId), name: `chain-${cfg.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as const satisfies Chain;
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  let paymaster: Address;

  if (cfg.mode === 'standalone') {
    paymaster = await ensureStandaloneContract(cfg, account.address, publicClient, wallet, log);
  } else {
    paymaster = getAddress(cfg.paymaster ?? account.address);
  }

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
  }

  // Stake (needed for validation-phase storage access under ERC-7562) and gas deposit.
  const info = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getDepositInfo', args: [paymaster] });
  // Admin functions belong to the contract owner: the relayer key itself for a self-deployed contract or a 7702 EOA.
  const owner = await publicClient.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'owner' }).catch(() => zeroAddress);
  const canAdmin = isAddressEqual(owner, account.address);
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

  if (cfg.requireRegistration !== false) await ensureRegistered(cfg, paymaster, publicClient, log);
  return paymaster;
}

/** Deploy the standalone worker contract from the relayer key on first start; remember it in the state file. */
async function ensureStandaloneContract(
  cfg: PaymasterSetupConfig,
  signer: Address,
  publicClient: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  log: Logger,
): Promise<Address> {
  const state: StateFile = cfg.stateFile && existsSync(cfg.stateFile) ? (JSON.parse(readFileSync(cfg.stateFile, 'utf8')) as StateFile) : {};
  const candidate = cfg.paymaster ?? state.paymaster;
  if (candidate) {
    const code = (await publicClient.getCode({ address: candidate })) ?? '0x';
    if (code === '0x') throw new Error(`no contract at paymaster address ${candidate}`);
    const signerOnChain = await publicClient.readContract({ address: candidate, abi: paymasterAbi, functionName: 'verifyingSigner' });
    if (!isAddressEqual(signerOnChain, signer)) {
      throw new Error(`paymaster ${candidate} expects signatures from ${signerOnChain}, this key is ${signer}`);
    }
    return getAddress(candidate);
  }
  if (!cfg.autoSetup) {
    throw new Error('no PAYMASTER_ADDRESS and AUTO_SETUP is off: deploy TornadoRelayerPaymaster (contracts/script/Deploy.s.sol) or enable AUTO_SETUP');
  }
  log.info('deploying the worker paymaster contract from the relayer key', {
    entryPoint: cfg.entryPoint,
    router: cfg.router ?? zeroAddress,
    gasMarginBps: (cfg.gasMarginBps ?? 1000n).toString(),
  });
  const hash = await wallet.deployContract({
    abi: paymasterArtifact.abi,
    bytecode: paymasterArtifact.bytecode,
    args: [cfg.entryPoint, signer, cfg.gasMarginBps ?? 1000n, cfg.postOpGasOverhead ?? 45_000n],
    chain: wallet.chain,
    account: wallet.account!,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`paymaster deployment ${hash} failed`);
  const paymaster = getAddress(receipt.contractAddress);
  if (cfg.router && cfg.router !== zeroAddress) {
    const tx = await wallet.writeContract({ address: paymaster, abi: paymasterAbi, functionName: 'setRouter', args: [cfg.router], chain: wallet.chain, account: wallet.account! });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }
  if (cfg.stateFile) writeFileSync(cfg.stateFile, JSON.stringify({ paymaster, deployTx: hash } satisfies StateFile, null, 2) + '\n');
  log.info('worker paymaster deployed', { paymaster, tx: hash, stateFile: cfg.stateFile });
  return paymaster;
}

/**
 * The DAO side of the setup is the master's, not the software's: `RelayerRegistry.registerWorker(master,
 * paymaster)` from the master key — the same action as adding a worker today. Until then the service waits
 * (or exits) with that instruction.
 */
async function ensureRegistered(
  cfg: PaymasterSetupConfig,
  paymaster: Address,
  publicClient: ReturnType<typeof createPublicClient>,
  log: Logger,
): Promise<void> {
  const router = await publicClient.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'router' });
  if (router === zeroAddress) return; // no DAO router on this chain: nothing to register with
  const registry = await publicClient.readContract({ address: router, abi: tornadoRouterAbi, functionName: 'relayerRegistry' });
  const master = cfg.rewardAccount ? getAddress(cfg.rewardAccount) : paymaster;
  const instruction =
    `paymaster ${paymaster} is not a registered worker of ${master}. From the master key call ` +
    `RelayerRegistry(${registry}).registerWorker(${master}, ${paymaster}) — the same step as adding a worker to tornado-relayer.`;
  for (let attempt = 0; ; attempt++) {
    const resolved = await publicClient.readContract({ address: registry, abi: relayerRegistryAbi, functionName: 'workers', args: [paymaster] });
    if (resolved !== zeroAddress) {
      if (!isAddressEqual(resolved, master)) {
        throw new Error(`registry resolves ${paymaster} to master ${resolved}, but REWARD_ACCOUNT is ${master}`);
      }
      if (attempt > 0) log.info('registry: paymaster is now registered', { master });
      return;
    }
    if (!cfg.waitForRegistration) throw new Error(instruction);
    if (attempt % 4 === 0) log.warn(instruction + ' Waiting…');
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
