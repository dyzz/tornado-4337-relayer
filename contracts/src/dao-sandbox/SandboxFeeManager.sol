// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITornadoInstance} from "../interfaces/ITornadoInstance.sol";
import {SandboxInstanceRegistry} from "./SandboxInstanceRegistry.sol";

/// @notice `FeeManager` (mainnet 0x5f6c…4D7) for the sandbox: same ABI and fee formula
/// (`denomination × protocolFee / 10000`, converted into TORN), but the TORN price comes from a
/// governance-set `tornPerAsset` table instead of a Uniswap V3 TWAP, since Sepolia has no
/// TORN/WETH pool.
contract SandboxFeeManager {
    uint256 public constant PROTOCOL_FEE_DIVIDER = 10000;
    address public immutable torn;
    address public immutable governance;
    SandboxInstanceRegistry public immutable registry;

    uint24 public uniswapTornPoolSwappingFee;
    uint32 public uniswapTimePeriod;
    uint24 public updateFeeTimeLimit;

    mapping(ITornadoInstance => uint160) public instanceFee;
    mapping(ITornadoInstance => uint256) public instanceFeeUpdated;
    /// @notice TORN (wei) per 1e18 base units of `asset`; address(0) = ETH. Replaces the TWAP.
    mapping(address => uint256) public tornPerAsset;

    struct Deviation {
        address instance;
        int256 deviation;
    }

    event FeeUpdated(address indexed instance, uint256 newFee);
    event UniswapTornPoolSwappingFeeChanged(uint24 newFee);
    event TornPriceSet(address indexed asset, uint256 tornPerAsset);

    modifier onlyGovernance() {
        require(msg.sender == governance, "only governance");
        _;
    }

    constructor(address _torn, address _governance, SandboxInstanceRegistry _registry, uint24 _updateFeeTimeLimit) {
        torn = _torn;
        governance = _governance;
        registry = _registry;
        updateFeeTimeLimit = _updateFeeTimeLimit;
        uniswapTornPoolSwappingFee = 10000;
        uniswapTimePeriod = 5400;
    }

    function updateAllFees() external {
        updateFees(registry.getAllInstanceAddresses());
    }

    function updateFees(ITornadoInstance[] memory _instances) public {
        for (uint256 i = 0; i < _instances.length; i++) {
            updateFee(_instances[i]);
        }
    }

    function updateFee(ITornadoInstance _instance) public {
        uint160 newFee = calculatePoolFee(_instance);
        instanceFee[_instance] = newFee;
        instanceFeeUpdated[_instance] = block.timestamp;
        emit FeeUpdated(address(_instance), newFee);
    }

    /// @notice Fee of a pool, refreshed when older than `updateFeeTimeLimit` (called by the registry on burn).
    function instanceFeeWithUpdate(ITornadoInstance _instance) public returns (uint160) {
        if (block.timestamp - instanceFeeUpdated[_instance] > updateFeeTimeLimit) {
            updateFee(_instance);
        }
        return instanceFee[_instance];
    }

    function calculatePoolFee(ITornadoInstance _instance) public view returns (uint160) {
        (bool isERC20, IERC20 token,,, uint32 protocolFeePercentage) = registry.instances(_instance);
        if (protocolFeePercentage == 0) {
            return 0;
        }
        address asset = isERC20 ? address(token) : address(0);
        uint256 price = tornPerAsset[asset];
        require(price != 0, "no TORN price for asset");
        return uint160((((_instance.denomination() * protocolFeePercentage) / PROTOCOL_FEE_DIVIDER) * price) / 1e18);
    }

    /// @notice Sandbox replacement for the Uniswap oracle: how many TORN one whole unit of `asset` buys.
    function setTornPerAsset(address asset, uint256 _tornPerAsset) external onlyGovernance {
        tornPerAsset[asset] = _tornPerAsset;
        emit TornPriceSet(asset, _tornPerAsset);
    }

    function setUniswapTornPoolSwappingFee(uint24 _uniswapTornPoolSwappingFee) public onlyGovernance {
        uniswapTornPoolSwappingFee = _uniswapTornPoolSwappingFee;
        emit UniswapTornPoolSwappingFeeChanged(uniswapTornPoolSwappingFee);
    }

    function setPeriodForTWAPOracle(uint32 newPeriod) external onlyGovernance {
        uniswapTimePeriod = newPeriod;
    }

    function setUpdateFeeTimeLimit(uint24 newLimit) external onlyGovernance {
        updateFeeTimeLimit = newLimit;
    }

    function feeDeviations() public view returns (Deviation[] memory results) {
        ITornadoInstance[] memory instances = registry.getAllInstanceAddresses();
        results = new Deviation[](instances.length);
        for (uint256 i = 0; i < instances.length; i++) {
            uint256 marketFee = calculatePoolFee(instances[i]);
            int256 deviation;
            if (marketFee != 0) {
                deviation = int256((uint256(instanceFee[instances[i]]) * 1000) / marketFee) - 1000;
            }
            results[i] = Deviation({instance: address(instances[i]), deviation: deviation});
        }
    }
}
