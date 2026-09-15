// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {ITornadoRouter} from "../src/interfaces/ITornadoRouter.sol";
import {TornadoRelayerPaymaster7702} from "../src/TornadoRelayerPaymaster7702.sol";

/// Deploys the per-chain EIP-7702 paymaster implementation that existing relayers delegate their
/// worker EOA to. Deployed once per chain; no owner, no per-relayer state.
///
///   PRIVATE_KEY           deployer (any key)
///   ENTRY_POINT           default: EntryPoint v0.8
///   TORNADO_ROUTER        DAO TornadoRouter (mainnet 0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b); required
///   GAS_MARGIN_BPS        default 1000 (10 %, master mode only)
///   POST_OP_GAS_OVERHEAD  default 45000
///
///   forge script script/Deploy7702.s.sol --rpc-url $RPC_URL --broadcast --verify
contract Deploy7702 is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address entryPoint = vm.envOr("ENTRY_POINT", 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
        address router = vm.envAddress("TORNADO_ROUTER");
        uint256 gasMarginBps = vm.envOr("GAS_MARGIN_BPS", uint256(1_000));
        uint256 postOpGasOverhead = vm.envOr("POST_OP_GAS_OVERHEAD", uint256(45_000));

        vm.startBroadcast(pk);
        TornadoRelayerPaymaster7702 impl = new TornadoRelayerPaymaster7702(
            IEntryPoint(entryPoint), ITornadoRouter(router), gasMarginBps, postOpGasOverhead
        );
        vm.stopBroadcast();
        console.log("TornadoRelayerPaymaster7702 implementation:", address(impl));
        console.log("  router:", router);
    }
}
