// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/core/EntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TornadoRelayerPaymaster} from "../src/TornadoRelayerPaymaster.sol";
import {ITornadoInstance} from "../src/interfaces/ITornadoInstance.sol";
import {IRelayerRegistry, ITornadoRouter} from "../src/interfaces/ITornadoRouter.sol";
import {ENSNamehash} from "../src/dao-sandbox/ENSNamehash.sol";
import {SandboxENS} from "../src/dao-sandbox/SandboxENS.sol";
import {SandboxFeeManager} from "../src/dao-sandbox/SandboxFeeManager.sol";
import {SandboxInstanceRegistry} from "../src/dao-sandbox/SandboxInstanceRegistry.sol";
import {SandboxRelayerRegistry} from "../src/dao-sandbox/SandboxRelayerRegistry.sol";
import {SandboxStakingRewards} from "../src/dao-sandbox/SandboxStakingRewards.sol";
import {SandboxTORN} from "../src/dao-sandbox/SandboxTORN.sol";
import {SandboxTornadoRouter} from "../src/dao-sandbox/SandboxTornadoRouter.sol";
import {MockTornado, MockTornadoERC20, MockERC20} from "./mocks/MockTornado.sol";

/// The Sepolia DAO sandbox wired exactly like the deploy script, driven through the paymaster.
contract DaoSandboxTest is Test {
    using ENSNamehash for bytes;

    uint256 constant MIN_STAKE = 5_000e18;
    uint256 constant TORN_PER_ETH = 379e18; // ~ mainnet at the time of writing (ETH-1 burns ~1.14 TORN)
    uint256 constant TORN_PER_DAI = 0.15e18;
    uint32 constant PROTOCOL_FEE = 30; // 0.30 %

    address governance = address(this);
    SandboxTORN torn;
    SandboxENS ens;
    SandboxStakingRewards staking;
    SandboxInstanceRegistry instanceRegistry;
    SandboxFeeManager feeManager;
    SandboxRelayerRegistry registry;
    SandboxTornadoRouter router;

    MockTornado ethPool; // 0.1 ETH
    MockERC20 dai;
    MockTornadoERC20 daiPool; // 100 DAI

    EntryPoint entryPoint;
    TornadoRelayerPaymaster paymaster;
    address relayerSigner = makeAddr("relayerSigner");
    address user = makeAddr("user");

    function setUp() public {
        torn = new SandboxTORN(governance, 10_000_000e18);
        ens = new SandboxENS();
        staking = new SandboxStakingRewards(governance, address(torn));
        instanceRegistry = new SandboxInstanceRegistry(governance);
        feeManager = new SandboxFeeManager(address(torn), governance, instanceRegistry, 172_800);
        registry = new SandboxRelayerRegistry(address(torn), governance, ens, staking, feeManager);
        router = new SandboxTornadoRouter(governance, instanceRegistry, registry);

        instanceRegistry.setTornadoRouter(address(router));
        registry.setTornadoRouter(address(router));
        staking.setRelayerRegistry(address(registry));
        registry.setMinStakeAmount(MIN_STAKE);

        ethPool = new MockTornado(0.1 ether);
        vm.deal(address(ethPool), 100 ether);
        dai = new MockERC20("Dai", "DAI", 18);
        daiPool = new MockTornadoERC20(dai, 100e18);
        dai.mint(address(daiPool), 1_000_000e18);

        _addInstance(address(ethPool), false, address(0), 0);
        _addInstance(address(daiPool), true, address(dai), 3000);
        feeManager.setTornPerAsset(address(0), TORN_PER_ETH);
        feeManager.setTornPerAsset(address(dai), TORN_PER_DAI);
        feeManager.updateAllFees();

        entryPoint = new EntryPoint();
        paymaster = new TornadoRelayerPaymaster(entryPoint, relayerSigner, 1_000, 45_000);
        paymaster.setRouter(ITornadoRouter(address(router)));
    }

    function _addInstance(address pool, bool isERC20, address token, uint24 swapFee) internal {
        instanceRegistry.updateInstance(
            SandboxInstanceRegistry.Tornado({
                addr: ITornadoInstance(pool),
                instance: SandboxInstanceRegistry.Instance({
                    isERC20: isERC20,
                    token: IERC20(token),
                    state: SandboxInstanceRegistry.InstanceState.ENABLED,
                    uniswapPoolSwappingFee: swapFee,
                    protocolFeePercentage: PROTOCOL_FEE
                })
            })
        );
    }

    /// Master mode exactly as the register script does it: ENS owner -> paymaster, TORN -> paymaster, registerAsRelayer.
    function _registerPaymasterAsMaster(string memory name) internal {
        ens.setOwner(bytes(name).namehash(), address(paymaster));
        torn.transfer(address(paymaster), MIN_STAKE);
        paymaster.registerAsRelayer(IRelayerRegistry(address(registry)), name, MIN_STAKE);
    }

    function _relay(address pool, bytes32 nullifierHash, address relayer, uint256 fee) internal {
        vm.prank(user);
        paymaster.relayWithdraw(ITornadoInstance(pool), hex"", bytes32(0), nullifierHash, payable(user), payable(relayer), fee);
    }

    // ------------------------------------------------------------ tests

    function test_namehash_matchesEip137() public pure {
        assertEq(bytes("eth").namehash(), 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae);
        assertEq(bytes("foo.eth").namehash(), 0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f);
        assertEq(bytes("").namehash(), bytes32(0));
    }

    function test_feeManager_mirrorsMainnetFormula() public view {
        // 0.1 ETH * 0.30 % = 0.0003 ETH -> * 379 TORN/ETH = 0.1137 TORN
        assertEq(feeManager.calculatePoolFee(ITornadoInstance(address(ethPool))), 0.1137e18);
        assertEq(feeManager.instanceFee(ITornadoInstance(address(ethPool))), 0.1137e18);
        // 100 DAI * 0.30 % = 0.3 DAI -> * 0.15 TORN/DAI = 0.045 TORN
        assertEq(feeManager.calculatePoolFee(ITornadoInstance(address(daiPool))), 0.045e18);
        assertEq(feeManager.feeDeviations().length, 2);
        assertEq(instanceRegistry.getAllInstanceAddresses().length, 2);
    }

    function test_register_requiresEnsOwnership() public {
        torn.transfer(address(paymaster), MIN_STAKE);
        vm.expectRevert("only ens owner");
        paymaster.registerAsRelayer(IRelayerRegistry(address(registry)), "not-mine.eth", MIN_STAKE);

        ens.setOwner(bytes("small.eth").namehash(), address(paymaster));
        vm.expectRevert("!min_stake");
        paymaster.registerAsRelayer(IRelayerRegistry(address(registry)), "small.eth", MIN_STAKE - 1);
    }

    function test_masterMode_burnsFromPaymasterStake_ethAndDai() public {
        _registerPaymasterAsMaster("relayer.sandbox.eth");
        assertEq(registry.workers(address(paymaster)), address(paymaster));
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE);
        assertEq(registry.getRelayerEnsHash(address(paymaster)), bytes("relayer.sandbox.eth").namehash());
        assertEq(torn.balanceOf(address(staking)), MIN_STAKE);

        uint256 fee = 0.002 ether;
        vm.expectEmit(address(registry));
        emit SandboxRelayerRegistry.StakeBurned(address(paymaster), 0.1137e18);
        _relay(address(ethPool), keccak256("eth"), address(paymaster), fee);
        assertEq(address(paymaster).balance, fee, "fee landed on the paymaster");
        assertEq(user.balance, 0.1 ether - fee);
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE - 0.1137e18);
        assertEq(staking.totalBurnRewards(), 0.1137e18);

        _relay(address(daiPool), keccak256("dai"), address(paymaster), 1e18);
        assertEq(dai.balanceOf(address(paymaster)), 1e18);
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE - 0.1137e18 - 0.045e18);
    }

    function test_workerMode_existingRelayerAddsPaymaster() public {
        address master = makeAddr("existingRelayer");
        ens.setOwner(bytes("existing.eth").namehash(), master);
        torn.transfer(master, MIN_STAKE);
        vm.startPrank(master);
        torn.approve(address(registry), MIN_STAKE);
        registry.register("existing.eth", MIN_STAKE, new address[](0));
        registry.registerWorker(master, address(paymaster));
        vm.stopPrank();

        uint256 fee = 0.002 ether;
        _relay(address(ethPool), keccak256("w"), master, fee);
        assertEq(master.balance, fee, "fee to the master EOA");
        assertEq(registry.getRelayerBalance(master), MIN_STAKE - 0.1137e18);
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE - 0.1137e18, "worker resolves to master");

        // A worker may not relay for another registered master.
        _registerOtherMaster();
        vm.expectRevert("only relayer");
        _relay(address(ethPool), keccak256("x"), address(paymaster), fee);
    }

    function _registerOtherMaster() internal {
        address other = makeAddr("other");
        ens.setOwner(bytes("other.eth").namehash(), other);
        torn.transfer(other, MIN_STAKE);
        vm.startPrank(other);
        torn.approve(address(registry), MIN_STAKE);
        registry.register("other.eth", MIN_STAKE, new address[](0));
        vm.stopPrank();
    }

    function test_unregisteredPaymaster_isCustomRelayer_noBurn() public {
        _relay(address(ethPool), keccak256("c"), address(paymaster), 0.001 ether);
        assertEq(staking.totalBurnRewards(), 0);
        // ... but it may not name a registered relayer.
        _registerOtherMaster();
        vm.expectRevert("Only custom relayer");
        _relay(address(ethPool), keccak256("d"), makeAddr("other"), 0.001 ether);
    }

    function test_router_rejectsUnknownInstance_andDepositsErc20() public {
        MockTornado stray = new MockTornado(1 ether);
        vm.prank(user);
        vm.expectRevert("The instance is not supported");
        paymaster.relayWithdraw(ITornadoInstance(address(stray)), hex"", bytes32(0), keccak256("s"), payable(user), payable(address(paymaster)), 0);

        // ERC-20 deposit through the router uses the allowance the instance registry granted.
        assertEq(dai.allowance(address(router), address(daiPool)), type(uint256).max);
        dai.mint(user, 100e18);
        vm.startPrank(user);
        dai.approve(address(router), 100e18);
        router.deposit(ITornadoInstance(address(daiPool)), keccak256("commitment"), "");
        vm.stopPrank();
        assertEq(dai.balanceOf(address(daiPool)), 1_000_100e18);
    }

    function test_governanceOnly() public {
        vm.startPrank(makeAddr("stranger"));
        vm.expectRevert("Not authorized");
        instanceRegistry.setProtocolFee(ITornadoInstance(address(ethPool)), 1);
        vm.expectRevert("only governance");
        feeManager.setTornPerAsset(address(0), 1);
        vm.expectRevert("only governance");
        registry.setMinStakeAmount(1);
        vm.expectRevert("only proxy");
        registry.burn(address(this), address(this), ITornadoInstance(address(ethPool)));
        vm.expectRevert("unauthorized");
        staking.addBurnRewards(1);
        vm.stopPrank();
    }
}
