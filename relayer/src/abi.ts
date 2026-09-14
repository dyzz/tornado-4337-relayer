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

/** TornadoRelayerPaymaster — read-only surface used at boot and for quoting. */
export const paymasterAbi = parseAbi([
  'function entryPoint() view returns (address)',
  'function verifyingSigner() view returns (address)',
  'function gasMarginBps() view returns (uint256)',
  'function postOpGasOverhead() view returns (uint256)',
  'function getDeposit() view returns (uint256)',
  'function PAYMASTER_AND_DATA_LENGTH() view returns (uint256)',
]);

/**
 * Account execution ABI shared by EntryPoint v0.8 reference accounts
 * (Simple7702Account, SimpleAccount): BaseAccount.execute / executeBatch.
 */
export const baseAccountAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch(Call[] calls)',
]);
