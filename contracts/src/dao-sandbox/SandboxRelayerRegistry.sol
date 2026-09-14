// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITornadoInstance} from "../interfaces/ITornadoInstance.sol";
import {ENSNamehash} from "./ENSNamehash.sol";
import {SandboxENS} from "./SandboxENS.sol";
import {SandboxFeeManager} from "./SandboxFeeManager.sol";
import {SandboxStakingRewards} from "./SandboxStakingRewards.sol";

/// @notice `RelayerRegistry` (mainnet 0x58E8…3dF2) for the sandbox: the registration, worker,
/// stake and burn logic verbatim; dependencies are passed as addresses instead of ENS nodes.
contract SandboxRelayerRegistry {
    using SafeERC20 for IERC20;
    using ENSNamehash for bytes;

    struct RelayerState {
        uint256 balance;
        bytes32 ensHash;
    }

    IERC20 public immutable torn;
    address public immutable governance;
    SandboxENS public immutable ens;
    SandboxStakingRewards public immutable staking;
    SandboxFeeManager public immutable feeManager;

    address public tornadoRouter;
    uint256 public minStakeAmount;

    mapping(address => RelayerState) public relayers;
    mapping(address => address) public workers;

    event RelayerBalanceNullified(address relayer);
    event WorkerRegistered(address relayer, address worker);
    event WorkerUnregistered(address relayer, address worker);
    event StakeAddedToRelayer(address relayer, uint256 amountStakeAdded);
    event StakeBurned(address relayer, uint256 amountBurned);
    event MinimumStakeAmount(uint256 minStakeAmount);
    event RouterRegistered(address tornadoRouter);
    event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount);

    modifier onlyGovernance() {
        require(msg.sender == governance, "only governance");
        _;
    }

    modifier onlyTornadoRouter() {
        require(msg.sender == tornadoRouter, "only proxy");
        _;
    }

    modifier onlyRelayer(address sender, address relayer) {
        require(workers[sender] == relayer, "only relayer");
        _;
    }

    constructor(
        address _torn,
        address _governance,
        SandboxENS _ens,
        SandboxStakingRewards _staking,
        SandboxFeeManager _feeManager
    ) {
        torn = IERC20(_torn);
        governance = _governance;
        ens = _ens;
        staking = _staking;
        feeManager = _feeManager;
    }

    /// @notice Register a master address + metadata (and optionally workers) for a relayer.
    function register(string calldata ensName, uint256 stake, address[] calldata workersToRegister) external {
        _register(msg.sender, ensName, stake, workersToRegister);
    }

    /// @dev Register with a permit approval instead of a regular approve.
    function registerPermit(
        string calldata ensName,
        uint256 stake,
        address[] calldata workersToRegister,
        address relayer,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        IERC20Permit(address(torn)).permit(relayer, address(this), stake, deadline, v, r, s);
        _register(relayer, ensName, stake, workersToRegister);
    }

    function _register(address relayer, string calldata ensName, uint256 stake, address[] calldata workersToRegister)
        internal
    {
        bytes32 ensHash = bytes(ensName).namehash();
        require(relayer == ens.owner(ensHash), "only ens owner");
        require(workers[relayer] == address(0), "cant register again");
        RelayerState storage metadata = relayers[relayer];

        require(metadata.ensHash == bytes32(0), "registered already");
        require(stake >= minStakeAmount, "!min_stake");

        torn.safeTransferFrom(relayer, address(staking), stake);
        emit StakeAddedToRelayer(relayer, stake);

        metadata.balance = stake;
        metadata.ensHash = ensHash;
        workers[relayer] = relayer;

        for (uint256 i = 0; i < workersToRegister.length; i++) {
            address worker = workersToRegister[i];
            _registerWorker(relayer, worker);
        }

        emit RelayerRegistered(ensHash, ensName, relayer, stake);
    }

    /// @notice Let a relayer register more workers.
    function registerWorker(address relayer, address worker) external onlyRelayer(msg.sender, relayer) {
        _registerWorker(relayer, worker);
    }

    function _registerWorker(address relayer, address worker) internal {
        require(workers[worker] == address(0), "can't steal an address");
        workers[worker] = relayer;
        emit WorkerRegistered(relayer, worker);
    }

    /// @notice Anybody may unregister an address they own.
    function unregisterWorker(address worker) external {
        if (worker != msg.sender) require(workers[worker] == msg.sender, "only owner of worker");
        require(workers[worker] != worker, "cant unregister master");
        emit WorkerUnregistered(workers[worker], worker);
        workers[worker] = address(0);
    }

    /// @notice Anybody may stake more TORN to a relayer.
    function stakeToRelayer(address relayer, uint256 stake) external {
        _stakeToRelayer(msg.sender, relayer, stake);
    }

    function stakeToRelayerPermit(
        address relayer,
        uint256 stake,
        address staker,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        IERC20Permit(address(torn)).permit(staker, address(this), stake, deadline, v, r, s);
        _stakeToRelayer(staker, relayer, stake);
    }

    function _stakeToRelayer(address staker, address relayer, uint256 stake) internal {
        require(workers[relayer] == relayer, "!registered");
        torn.safeTransferFrom(staker, address(staking), stake);
        relayers[relayer].balance = stake + relayers[relayer].balance;
        emit StakeAddedToRelayer(relayer, stake);
    }

    /// @notice Burn some relayer stake on withdraw and notify staking (router only).
    function burn(address sender, address relayer, ITornadoInstance pool) external onlyTornadoRouter {
        address masterAddress = workers[sender];
        if (masterAddress == address(0)) {
            require(workers[relayer] == address(0), "Only custom relayer");
            return;
        }

        require(masterAddress == relayer, "only relayer");
        uint256 toBurn = feeManager.instanceFeeWithUpdate(pool);
        relayers[relayer].balance = relayers[relayer].balance - toBurn;
        staking.addBurnRewards(toBurn);
        emit StakeBurned(relayer, toBurn);
    }

    function setMinStakeAmount(uint256 minAmount) external onlyGovernance {
        minStakeAmount = minAmount;
        emit MinimumStakeAmount(minAmount);
    }

    function setTornadoRouter(address tornadoRouterAddress) external onlyGovernance {
        tornadoRouter = tornadoRouterAddress;
        emit RouterRegistered(tornadoRouterAddress);
    }

    function nullifyBalance(address relayer) external onlyGovernance {
        address masterAddress = workers[relayer];
        require(relayer == masterAddress, "must be master");
        relayers[masterAddress].balance = 0;
        emit RelayerBalanceNullified(relayer);
    }

    function isRelayer(address toResolve) external view returns (bool) {
        return workers[toResolve] != address(0);
    }

    function isRelayerRegistered(address relayer, address toResolve) external view returns (bool) {
        return workers[toResolve] == relayer;
    }

    function getRelayerEnsHash(address relayer) external view returns (bytes32) {
        return relayers[workers[relayer]].ensHash;
    }

    function getRelayerBalance(address relayer) external view returns (uint256) {
        return relayers[workers[relayer]].balance;
    }
}
