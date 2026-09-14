// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {TornadoRelayerPaymaster} from "../src/TornadoRelayerPaymaster.sol";
import {ITornadoRouter} from "../src/interfaces/ITornadoRouter.sol";
import {SwapAndSupplyZap, IWETH, ISwapRouter02, IAavePool} from "../src/SwapAndSupplyZap.sol";

/// Deploys the paymaster (and optionally the zap) and funds the EntryPoint deposit.
///
///   PRIVATE_KEY           deployer / paymaster owner
///   RELAYER_SIGNER        address of the relayer's signing key (verifyingSigner)
///   ENTRY_POINT           default: EntryPoint v0.8
///   GAS_MARGIN_BPS        default 1000 (10 %)
///   POST_OP_GAS_OVERHEAD  default 45000
///   DEPOSIT_WEI           initial EntryPoint deposit (default 0)
///   TORNADO_ROUTER        DAO TornadoRouter (mainnet 0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b); unset on chains
///                         without one (Sepolia) -> the paymaster calls pools directly
///   DEPLOY_ZAP=true       also deploy SwapAndSupplyZap with WETH / SWAP_ROUTER / AAVE_POOL
///
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address signer = vm.envAddress("RELAYER_SIGNER");
        address entryPoint = vm.envOr("ENTRY_POINT", 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
        uint256 gasMarginBps = vm.envOr("GAS_MARGIN_BPS", uint256(1_000));
        uint256 postOpGasOverhead = vm.envOr("POST_OP_GAS_OVERHEAD", uint256(45_000));
        uint256 depositWei = vm.envOr("DEPOSIT_WEI", uint256(0));

        vm.startBroadcast(pk);
        TornadoRelayerPaymaster paymaster =
            new TornadoRelayerPaymaster(IEntryPoint(entryPoint), signer, gasMarginBps, postOpGasOverhead);
        if (depositWei > 0) paymaster.deposit{value: depositWei}();
        address router = vm.envOr("TORNADO_ROUTER", address(0));
        if (router != address(0)) paymaster.setRouter(ITornadoRouter(router));
        console.log("TornadoRelayerPaymaster:", address(paymaster));
        console.log("  router:", router);

        if (vm.envOr("DEPLOY_ZAP", false)) {
            SwapAndSupplyZap zap = new SwapAndSupplyZap(
                IWETH(vm.envAddress("WETH")),
                ISwapRouter02(vm.envAddress("SWAP_ROUTER")),
                IAavePool(vm.envAddress("AAVE_POOL"))
            );
            console.log("SwapAndSupplyZap:", address(zap));
        }
        vm.stopBroadcast();
    }
}
