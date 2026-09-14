import { parseAbi } from 'viem';

export const tornadoAbi = parseAbi([
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
  'function denomination() view returns (uint256)',
  'function levels() view returns (uint32)',
  'function nextIndex() view returns (uint32)',
  'function getLastRoot() view returns (bytes32)',
  'function isKnownRoot(bytes32 root) view returns (bool)',
  'function isSpent(bytes32 nullifierHash) view returns (bool)',
  'function deposit(bytes32 commitment) payable',
  'function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund) payable',
]);

export const zapAbi = parseAbi([
  'function swapEthAndSupply(address tokenOut, uint24 poolFee, uint256 minOut, address onBehalfOf) payable returns (uint256 amountOut)',
  'function wrapEthAndSupply(address onBehalfOf) payable',
]);

export const paymasterAdminAbi = parseAbi([
  'function deposit() payable',
  'function getDeposit() view returns (uint256)',
  'function verifyingSigner() view returns (address)',
  'function gasMarginBps() view returns (uint256)',
  'function postOpGasOverhead() view returns (uint256)',
  'event Sponsored(bytes32 indexed userOpHash, address indexed refundTo, uint256 fee, uint256 actualGasCost, uint256 refund)',
  'event SponsoredOpReverted(bytes32 indexed userOpHash, uint256 actualGasCost)',
  'event RefundFailed(bytes32 indexed userOpHash, address indexed refundTo, uint256 amount)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const aavePoolAbi = parseAbi([
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);
