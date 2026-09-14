import { parseAbi } from 'viem';

export const tornadoAbi = parseAbi([
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
  'function denomination() view returns (uint256)',
  'function token() view returns (address)',
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
  'function swapTokenAndSupply(address tokenIn, uint256 amountIn, address tokenOut, uint24 poolFee, uint256 minOut, address onBehalfOf) returns (uint256 amountOut)',
  'function wrapEthAndSupply(address onBehalfOf) payable',
  'function supplyToken(address token, uint256 amount, address onBehalfOf)',
]);

export const paymasterAdminAbi = parseAbi([
  'function deposit() payable',
  'function getDeposit() view returns (uint256)',
  'function withdrawTo(address to, uint256 amount)',
  'function verifyingSigner() view returns (address)',
  'function gasMarginBps() view returns (uint256)',
  'function postOpGasOverhead() view returns (uint256)',
  'function router() view returns (address)',
  'function setRouter(address router)',
  'function registerAsRelayer(address registry, string ensName, uint256 stake)',
  'function adminCall(address target, uint256 value, bytes data) returns (bytes)',
  'function relayWithdraw(address pool, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee)',
  'function sweep(address to, uint256 amount)',
  'function sweepERC20(address token, address to, uint256 amount)',
  'event Sponsored(bytes32 indexed userOpHash, address indexed refundTo, address indexed feeToken, uint256 fee, uint256 actualGasCost, uint256 refund)',
  'event SponsoredOpReverted(bytes32 indexed userOpHash, uint256 actualGasCost)',
  'event RefundFailed(bytes32 indexed userOpHash, address indexed refundTo, address indexed feeToken, uint256 amount)',
  'event FeeNotReceived(bytes32 indexed userOpHash, address indexed feeToken, uint256 expectedFee)',
  'event Relayed(address indexed pool, bytes32 indexed nullifierHash, address indexed relayer, uint256 fee, bool viaRouter)',
]);

/** Tornado DAO relayer registry (mainnet 0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2). */
export const relayerRegistryAbi = parseAbi([
  'function workers(address worker) view returns (address)',
  'function getRelayerBalance(address relayer) view returns (uint256)',
  'function getRelayerEnsHash(address relayer) view returns (bytes32)',
  'function isRelayer(address toResolve) view returns (bool)',
  'function minStakeAmount() view returns (uint256)',
  'function feeManager() view returns (address)',
  'function staking() view returns (address)',
  'function torn() view returns (address)',
  'function tornadoRouter() view returns (address)',
  'function register(string ensName, uint256 stake, address[] workersToRegister)',
  'function registerWorker(address relayer, address worker)',
  'function stakeToRelayer(address relayer, uint256 stake)',
  'event StakeBurned(address relayer, uint256 amountBurned)',
  'event WorkerRegistered(address relayer, address worker)',
  'event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount)',
]);

export const tornadoRouterAbi = parseAbi([
  'function relayerRegistry() view returns (address)',
  'function instanceRegistry() view returns (address)',
]);

/** Tornado DAO instance registry: which pools the router serves and their protocol (burn) fee. */
export const instanceRegistryAbi = parseAbi([
  'struct Instance { bool isERC20; address token; uint8 state; uint24 uniswapPoolSwappingFee; uint32 protocolFeePercentage; }',
  'struct Tornado { address addr; Instance instance; }',
  'function governance() view returns (address)',
  'function instances(address) view returns (bool isERC20, address token, uint8 state, uint24 uniswapPoolSwappingFee, uint32 protocolFeePercentage)',
  'function updateInstance(Tornado tornado)',
]);

export const feeManagerAbi = parseAbi([
  'function instanceFee(address instance) view returns (uint160)',
  'function instanceFeeWithUpdate(address instance) returns (uint160)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export const aavePoolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);
