// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITornadoInstance} from "../interfaces/ITornadoInstance.sol";

interface IRouterApprover {
    function approveExactToken(IERC20 token, address spender, uint256 amount) external;
}

/// @notice `InstanceRegistry` (mainnet 0xB20c…A911) for the sandbox: same structs, ABI and
/// rules, governance is a plain address.
contract SandboxInstanceRegistry {
    enum InstanceState {
        DISABLED,
        ENABLED
    }

    struct Instance {
        bool isERC20;
        IERC20 token;
        InstanceState state;
        // the fee of the uniswap pool which will be used to get a TWAP
        uint24 uniswapPoolSwappingFee;
        // the fee the protocol takes from relayer, it should be multiplied by PROTOCOL_FEE_DIVIDER from FeeManager.sol
        uint32 protocolFeePercentage;
    }

    struct Tornado {
        ITornadoInstance addr;
        Instance instance;
    }

    address public immutable governance;
    IRouterApprover public router;

    mapping(ITornadoInstance => Instance) public instances;
    ITornadoInstance[] public instanceIds;

    event InstanceStateUpdated(ITornadoInstance indexed instance, InstanceState state);
    event RouterRegistered(address tornadoRouter);

    modifier onlyGovernance() {
        require(msg.sender == governance, "Not authorized");
        _;
    }

    constructor(address _governance) {
        governance = _governance;
    }

    /// @dev Add or update an instance.
    function updateInstance(Tornado calldata _tornado) external virtual onlyGovernance {
        require(_tornado.instance.state != InstanceState.DISABLED, "Use removeInstance() for remove");
        if (instances[_tornado.addr].state == InstanceState.DISABLED) {
            instanceIds.push(_tornado.addr);
        }
        _updateInstance(_tornado);
    }

    /// @dev Remove an instance.
    function removeInstance(uint256 _instanceId) external virtual onlyGovernance {
        ITornadoInstance _instance = instanceIds[_instanceId];
        (bool isERC20, IERC20 token) = (instances[_instance].isERC20, instances[_instance].token);
        if (isERC20) {
            uint256 allowance = token.allowance(address(router), address(_instance));
            if (allowance != 0) {
                router.approveExactToken(token, address(_instance), 0);
            }
        }
        delete instances[_instance];
        instanceIds[_instanceId] = instanceIds[instanceIds.length - 1];
        instanceIds.pop();
        emit InstanceStateUpdated(_instance, InstanceState.DISABLED);
    }

    function setProtocolFee(ITornadoInstance instance, uint32 newFee) external onlyGovernance {
        instances[instance].protocolFeePercentage = newFee;
    }

    function setTornadoRouter(address routerAddress) external onlyGovernance {
        router = IRouterApprover(routerAddress);
        emit RouterRegistered(routerAddress);
    }

    function _updateInstance(Tornado memory _tornado) internal virtual {
        instances[_tornado.addr] = _tornado.instance;
        if (_tornado.instance.isERC20) {
            IERC20 token = IERC20(_tornado.addr.token());
            require(token == _tornado.instance.token, "Incorrect token");
            uint256 allowance = token.allowance(address(router), address(_tornado.addr));
            if (allowance == 0) {
                router.approveExactToken(token, address(_tornado.addr), type(uint256).max);
            }
        }
        emit InstanceStateUpdated(_tornado.addr, _tornado.instance.state);
    }

    function getAllInstances() public view returns (Tornado[] memory result) {
        result = new Tornado[](instanceIds.length);
        for (uint256 i = 0; i < instanceIds.length; i++) {
            result[i] = Tornado({addr: instanceIds[i], instance: instances[instanceIds[i]]});
        }
    }

    function getAllInstanceAddresses() public view returns (ITornadoInstance[] memory result) {
        result = new ITornadoInstance[](instanceIds.length);
        for (uint256 i = 0; i < instanceIds.length; i++) {
            result[i] = instanceIds[i];
        }
    }

    function getPoolToken(ITornadoInstance instance) external view returns (address) {
        return address(instances[instance].token);
    }
}
