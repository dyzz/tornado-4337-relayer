import { parseAbi } from 'viem';

/** Tornado Cash instance (ETHTornado / ERC20Tornado) — the subset the relayer needs. */
export const tornadoInstanceAbi = parseAbi([
  'function denomination() view returns (uint256)',
  'function token() view returns (address)',
  'function isSpent(bytes32 nullifierHash) view returns (bool)',
  'function isKnownRoot(bytes32 root) view returns (bool)',
  'function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund) payable',
]);

export const erc20MetadataAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** TornadoRelayerPaymaster — read surface used at boot / quoting plus the relay entry point. */
export const paymasterAbi = parseAbi([
  'function entryPoint() view returns (address)',
  'function verifyingSigner() view returns (address)',
  'function gasMarginBps() view returns (uint256)',
  'function postOpGasOverhead() view returns (uint256)',
  'function router() view returns (address)',
  'function owner() view returns (address)',
  'function setRouter(address router)',
  'function getDeposit() view returns (uint256)',
  'function deposit() payable',
  'function addStake(uint32 unstakeDelaySec) payable',
  'function PAYMASTER_AND_DATA_LENGTH() view returns (uint256)',
  'function relayWithdraw(address pool, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee)',
  'function simulateRelayWithdraw(address pool, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee)',
  'error SimulationResult(bool success, bytes result)',
  'error NotSponsored(address sender)',
  'error OnlyRecipient()',
]);

/** EntryPoint v0.8 stake / deposit info. */
export const entryPointAbi = parseAbi([
  'struct DepositInfo { uint256 deposit; bool staked; uint112 stake; uint32 unstakeDelaySec; uint48 withdrawTime; }',
  'function getDepositInfo(address account) view returns (DepositInfo info)',
  'function balanceOf(address account) view returns (uint256)',
]);

/** DAO TornadoRouter (mainnet 0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b). */
export const tornadoRouterAbi = parseAbi([
  'function relayerRegistry() view returns (address)',
  'function instanceRegistry() view returns (address)',
]);

/** RelayerRegistry (mainnet 0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2). */
export const relayerRegistryAbi = parseAbi([
  'function workers(address worker) view returns (address)',
  'function getRelayerBalance(address relayer) view returns (uint256)',
  'function getRelayerEnsHash(address relayer) view returns (bytes32)',
  'function minStakeAmount() view returns (uint256)',
  'function feeManager() view returns (address)',
  'function tornadoRouter() view returns (address)',
]);

/** FeeManager: TORN burned per withdrawal of an instance (0 where governance set no protocol fee). */
export const feeManagerAbi = parseAbi(['function instanceFee(address instance) view returns (uint160)']);

/**
 * Account execution ABI shared by EntryPoint v0.8 reference accounts
 * (Simple7702Account, SimpleAccount): BaseAccount.execute / executeBatch.
 */
export const baseAccountAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch(Call[] calls)',
]);
