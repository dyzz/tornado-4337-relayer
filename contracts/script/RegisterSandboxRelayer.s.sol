// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TornadoRelayerPaymaster} from "../src/TornadoRelayerPaymaster.sol";
import {IRelayerRegistry, ITornadoRouter} from "../src/interfaces/ITornadoRouter.sol";
import {ENSNamehash} from "../src/dao-sandbox/ENSNamehash.sol";
import {SandboxENS} from "../src/dao-sandbox/SandboxENS.sol";

/// Registers an existing TornadoRelayerPaymaster as a relayer *master* in the sandbox DAO:
/// gives it the ENS name (sandbox ENS admin), the stake in TORN, points it at the router and
/// calls `registerAsRelayer`. Run as the paymaster owner (= sandbox governance).
///
///   PRIVATE_KEY, PAYMASTER, SANDBOX_ROUTER, SANDBOX_REGISTRY, SANDBOX_ENS, SANDBOX_TORN
///   ENS_NAME   e.g. relayer.sandbox.eth      STAKE   default 5000e18
contract RegisterSandboxRelayer is Script {
    using ENSNamehash for bytes;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TornadoRelayerPaymaster paymaster = TornadoRelayerPaymaster(payable(vm.envAddress("PAYMASTER")));
        address router = vm.envAddress("SANDBOX_ROUTER");
        IRelayerRegistry registry = IRelayerRegistry(vm.envAddress("SANDBOX_REGISTRY"));
        SandboxENS ens = SandboxENS(vm.envAddress("SANDBOX_ENS"));
        IERC20 torn = IERC20(vm.envAddress("SANDBOX_TORN"));
        string memory ensName = vm.envString("ENS_NAME");
        uint256 stake = vm.envOr("STAKE", uint256(5_000e18));

        vm.startBroadcast(pk);
        ens.setOwner(bytes(ensName).namehash(), address(paymaster));
        torn.transfer(address(paymaster), stake);
        if (address(paymaster.router()) != router) paymaster.setRouter(ITornadoRouter(router));
        paymaster.registerAsRelayer(registry, ensName, stake);
        vm.stopBroadcast();

        console.log("paymaster", address(paymaster), "registered as", ensName);
        console.log("  master:", registry.workers(address(paymaster)));
        console.log("  stake (TORN wei):", registry.getRelayerBalance(address(paymaster)));
    }
}
