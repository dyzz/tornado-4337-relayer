// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITornadoInstance} from "../src/interfaces/ITornadoInstance.sol";
import {SandboxENS} from "../src/dao-sandbox/SandboxENS.sol";
import {SandboxFeeManager} from "../src/dao-sandbox/SandboxFeeManager.sol";
import {SandboxInstanceRegistry} from "../src/dao-sandbox/SandboxInstanceRegistry.sol";
import {SandboxRelayerRegistry} from "../src/dao-sandbox/SandboxRelayerRegistry.sol";
import {SandboxStakingRewards} from "../src/dao-sandbox/SandboxStakingRewards.sol";
import {SandboxTORN} from "../src/dao-sandbox/SandboxTORN.sol";
import {SandboxTornadoRouter} from "../src/dao-sandbox/SandboxTornadoRouter.sol";

/// Deploys a self-contained copy of the Tornado DAO relayer stack (TORN, ENS, staking,
/// InstanceRegistry, FeeManager, RelayerRegistry, TornadoRouter) on a testnet where the DAO
/// never deployed one, and enables the chain's existing Tornado pools in it.
///
///   PRIVATE_KEY            deployer = governance of every sandbox contract
///   SANDBOX_ETH_POOLS      comma-separated ETH instances to enable
///   SANDBOX_ERC20_POOLS    comma-separated ERC-20 instances to enable (token read from the pool)
///   PROTOCOL_FEE           protocol fee in 1e-4 (default 30 = 0.30 %, the DAO's setting for ETH-1)
///   TORN_PER_ETH           TORN (wei) per 1 ETH (default 379e18 ≈ mainnet at the time of writing)
///   TORN_PER_TOKEN         TORN (wei) per 1 whole ERC-20 token, applied to every ERC-20 pool token (default 0.15e18)
///   MIN_STAKE              default 5000e18 (mainnet)
///   TORN_SUPPLY            minted to the deployer (default 10_000_000e18)
///
///   forge script script/DeploySandboxDao.s.sol --rpc-url $RPC_URL --broadcast
contract DeploySandboxDao is Script {
    struct Config {
        uint256 pk;
        address governance;
        uint32 protocolFee;
        uint256 tornPerEth;
        uint256 tornPerToken;
        uint256 minStake;
        uint256 supply;
        address[] ethPools;
        address[] erc20Pools;
    }

    struct Deployed {
        SandboxTORN torn;
        SandboxENS ens;
        SandboxStakingRewards staking;
        SandboxInstanceRegistry instanceRegistry;
        SandboxFeeManager feeManager;
        SandboxRelayerRegistry relayerRegistry;
        SandboxTornadoRouter router;
    }

    function run() external {
        Config memory c = _config();
        vm.startBroadcast(c.pk);
        Deployed memory d = _deploy(c);
        _wire(c, d);
        vm.stopBroadcast();
        _report(c, d);
    }

    function _config() internal view returns (Config memory c) {
        c.pk = vm.envUint("PRIVATE_KEY");
        c.governance = vm.addr(c.pk);
        c.protocolFee = uint32(vm.envOr("PROTOCOL_FEE", uint256(30)));
        c.tornPerEth = vm.envOr("TORN_PER_ETH", uint256(379e18));
        c.tornPerToken = vm.envOr("TORN_PER_TOKEN", uint256(0.15e18));
        c.minStake = vm.envOr("MIN_STAKE", uint256(5_000e18));
        c.supply = vm.envOr("TORN_SUPPLY", uint256(10_000_000e18));
        c.ethPools = vm.envOr("SANDBOX_ETH_POOLS", ",", new address[](0));
        c.erc20Pools = vm.envOr("SANDBOX_ERC20_POOLS", ",", new address[](0));
    }

    function _deploy(Config memory c) internal returns (Deployed memory d) {
        d.torn = new SandboxTORN(c.governance, c.supply);
        d.ens = new SandboxENS();
        d.staking = new SandboxStakingRewards(c.governance, address(d.torn));
        d.instanceRegistry = new SandboxInstanceRegistry(c.governance);
        d.feeManager = new SandboxFeeManager(address(d.torn), c.governance, d.instanceRegistry, 172_800);
        d.relayerRegistry = new SandboxRelayerRegistry(address(d.torn), c.governance, d.ens, d.staking, d.feeManager);
        d.router = new SandboxTornadoRouter(c.governance, d.instanceRegistry, d.relayerRegistry);
    }

    function _wire(Config memory c, Deployed memory d) internal {
        d.instanceRegistry.setTornadoRouter(address(d.router));
        d.relayerRegistry.setTornadoRouter(address(d.router));
        d.staking.setRelayerRegistry(address(d.relayerRegistry));
        d.relayerRegistry.setMinStakeAmount(c.minStake);
        d.feeManager.setTornPerAsset(address(0), c.tornPerEth);
        for (uint256 i = 0; i < c.ethPools.length; i++) {
            _enable(d.instanceRegistry, c.ethPools[i], false, address(0), 0, c.protocolFee);
        }
        for (uint256 i = 0; i < c.erc20Pools.length; i++) {
            address token = ITornadoInstance(c.erc20Pools[i]).token();
            _enable(d.instanceRegistry, c.erc20Pools[i], true, token, 3000, c.protocolFee);
            if (d.feeManager.tornPerAsset(token) == 0) d.feeManager.setTornPerAsset(token, c.tornPerToken);
        }
        d.feeManager.updateAllFees();
    }

    function _report(Config memory c, Deployed memory d) internal view {
        console.log("SandboxTORN:            ", address(d.torn));
        console.log("SandboxENS:             ", address(d.ens));
        console.log("SandboxStakingRewards:  ", address(d.staking));
        console.log("SandboxInstanceRegistry:", address(d.instanceRegistry));
        console.log("SandboxFeeManager:      ", address(d.feeManager));
        console.log("SandboxRelayerRegistry: ", address(d.relayerRegistry));
        console.log("SandboxTornadoRouter:   ", address(d.router));
        for (uint256 i = 0; i < c.ethPools.length; i++) {
            console.log("  ETH pool", c.ethPools[i], "burn/withdraw (TORN wei):", d.feeManager.instanceFee(ITornadoInstance(c.ethPools[i])));
        }
        for (uint256 i = 0; i < c.erc20Pools.length; i++) {
            console.log("  ERC20 pool", c.erc20Pools[i], "burn/withdraw (TORN wei):", d.feeManager.instanceFee(ITornadoInstance(c.erc20Pools[i])));
        }
    }

    function _enable(
        SandboxInstanceRegistry registry,
        address pool,
        bool isERC20,
        address token,
        uint24 swapFee,
        uint32 protocolFee
    ) internal {
        registry.updateInstance(
            SandboxInstanceRegistry.Tornado({
                addr: ITornadoInstance(pool),
                instance: SandboxInstanceRegistry.Instance({
                    isERC20: isERC20,
                    token: IERC20(token),
                    state: SandboxInstanceRegistry.InstanceState.ENABLED,
                    uniswapPoolSwappingFee: swapFee,
                    protocolFeePercentage: protocolFee
                })
            })
        );
    }
}
