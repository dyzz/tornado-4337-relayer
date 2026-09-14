// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice `TornadoStakingRewards` (mainnet 0x5B3f…8c29) for the sandbox. Same surface;
/// burn rewards accrue per TORN held by this contract (the relayers' stakes) instead of per
/// TORN locked in governance, since the sandbox has no governance vault.
contract SandboxStakingRewards {
    using SafeERC20 for IERC20;

    /// @notice 1e25 on mainnet (TORN total supply)
    uint256 public immutable ratioConstant;
    address public immutable Governance;
    IERC20 public immutable torn;
    address public relayerRegistry;

    uint256 public accumulatedRewardPerTorn;
    mapping(address => uint256) public accumulatedRewardRateOnLastUpdate;
    mapping(address => uint256) public accumulatedRewards;
    /// @notice Sandbox extra: TORN burned by relayers so far (credited to this contract).
    uint256 public totalBurnRewards;

    event RewardsUpdated(address indexed account, uint256 rewards);
    event RewardsClaimed(address indexed account, uint256 rewardsClaimed);
    event RelayerRegistrySet(address relayerRegistry);

    modifier onlyGovernance() {
        require(msg.sender == Governance, "only governance");
        _;
    }

    constructor(address governanceAddress, address tornAddress) {
        Governance = governanceAddress;
        torn = IERC20(tornAddress);
        ratioConstant = IERC20(tornAddress).totalSupply();
    }

    /// @dev Mainnet resolves the registry through ENS at construction; the sandbox wires it once.
    function setRelayerRegistry(address _relayerRegistry) external onlyGovernance {
        require(relayerRegistry == address(0), "already set");
        relayerRegistry = _relayerRegistry;
        emit RelayerRegistrySet(_relayerRegistry);
    }

    function getReward() external {
        uint256 rewards = _updateReward(msg.sender);
        if (rewards > 0) {
            accumulatedRewards[msg.sender] = 0;
            torn.safeTransfer(msg.sender, rewards);
            emit RewardsClaimed(msg.sender, rewards);
        }
    }

    /// @notice Called by the registry on every relayer burn.
    function addBurnRewards(uint256 amount) external {
        require(msg.sender == Governance || msg.sender == relayerRegistry, "unauthorized");
        totalBurnRewards += amount;
        uint256 staked = torn.balanceOf(address(this));
        if (staked > 0) accumulatedRewardPerTorn += (amount * ratioConstant) / staked;
    }

    function updateRewardsOnLockedBalanceChange(address account, uint256) external onlyGovernance {
        uint256 claimed = _updateReward(account);
        emit RewardsUpdated(account, claimed);
    }

    function setReward(address account, uint256 amount) external onlyGovernance {
        accumulatedRewards[account] = amount;
        emit RewardsUpdated(account, amount);
    }

    function withdrawTorn(uint256 amount) external onlyGovernance {
        torn.safeTransfer(Governance, amount);
    }

    function checkReward(address account) external view returns (uint256 rewards) {
        return accumulatedRewards[account];
    }

    function _updateReward(address account) internal returns (uint256 claimed) {
        accumulatedRewardRateOnLastUpdate[account] = accumulatedRewardPerTorn;
        return accumulatedRewards[account];
    }
}
