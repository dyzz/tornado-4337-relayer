// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {BaseAccount} from "@account-abstraction/core/BaseAccount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {TornadoRelayerPaymaster} from "../../src/TornadoRelayerPaymaster.sol";
import {TornadoRelayerPaymasterCore} from "../../src/TornadoRelayerPaymasterCore.sol";
import {SwapAndSupplyZap, IWETH, ISwapRouter02, IAavePool} from "../../src/SwapAndSupplyZap.sol";
import {ITornadoInstance} from "../../src/interfaces/ITornadoInstance.sol";
import {ITornadoRouter, IRelayerRegistry} from "../../src/interfaces/ITornadoRouter.sol";

interface IFeeManager {
    function instanceFee(address instance) external view returns (uint160);
}

interface IInstanceRegistry {
    function instances(address) external view returns (bool, address, uint8, uint24, uint32);
}

interface IAavePoolData {
    function getReserveData(address asset) external view returns (ReserveData memory);

    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
}

/// Mainnet acceptance on a pinned fork (MAINNET_RPC_URL, block 25_981_000): the canonical Tornado
/// ETH 100 pool, the DAO's live TornadoRouter / RelayerRegistry / FeeManager, the real EntryPoint
/// v0.8 and Simple7702Account, a really registered relayer master (solid-relayer.eth) — nothing
/// governance-owned touched. The worker paymaster is deployed from the relayer key exactly as the
/// software does; the only impersonated step is the master registering it (`vm.prank`), which is the
/// master's own action. The withdrawal proof comes from the client prover via ffi against the
/// committed leaf fixture for this block.
///
///   MAINNET_RPC_URL=http://… TORNADO_ARTIFACTS_DIR=…/tornado-cli/circuits forge test --match-contract MainnetAcceptance -vv
contract MainnetAcceptanceTest is Test {
    uint256 constant FORK_BLOCK = 25_981_000;
    IEntryPoint constant ENTRY_POINT = IEntryPoint(0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
    address constant SIMPLE_7702 = 0xe6Cae83BdE06E4c305530e199D7217f42808555B;
    ITornadoRouter constant ROUTER = ITornadoRouter(0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b);
    IRelayerRegistry constant REGISTRY = IRelayerRegistry(0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2);
    IFeeManager constant FEE_MANAGER = IFeeManager(0x5f6c97C6AD7bdd0AE7E0Dd4ca33A4ED3fDabD4D7);
    IInstanceRegistry constant INSTANCE_REGISTRY = IInstanceRegistry(0xB20c66C4DE72433F3cE747b58B86830c459CA911);
    ITornadoInstance constant POOL = ITornadoInstance(0xA160cdAB225685dA1d56aa342Ad8841c3b53f291); // ETH 100
    address constant MASTER = 0xb69e1e65142d293035323470d2B3c0c5d4E03F8e; // solid-relayer.eth
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant UNISWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    string constant LEAVES_FIXTURE = "../client/e2e/fork-cache/leaves-1-0xA160cdAB225685dA1d56aa342Ad8841c3b53f291.json.gz";

    uint256 relayerKey = 0x5e1a7e5;
    address relayer = vm.addr(relayerKey);
    uint256 userKey = 0x7702aa;
    address user = vm.addr(userKey); // the EIP-7702 sender (and the note's recipient)
    address finalRecipient = makeAddr("finalRecipient");
    address payable beneficiary = payable(makeAddr("bundler"));

    TornadoRelayerPaymaster paymaster;
    SwapAndSupplyZap zap;

    // Withdrawal under test (storage, to keep the test function's stack small).
    uint256 fee = 0.3015 ether; // 0.30 % service fee + gas, as the relayer would quote
    bytes32 commitment;
    bytes32 root;
    bytes32 nullifierHash;
    bytes proof;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        // The relayer software's first start: deploy the worker contract from the relayer key, wire the
        // router, stake and fund it.
        vm.deal(relayer, 5 ether);
        vm.startPrank(relayer);
        paymaster = new TornadoRelayerPaymaster(ENTRY_POINT, relayer, 1_000, 45_000);
        paymaster.setRouter(ROUTER);
        paymaster.addStake{value: 0.1 ether}(1 days);
        paymaster.deposit{value: 2 ether}();
        vm.stopPrank();

        // The master's own action: register the new worker.
        vm.prank(MASTER);
        REGISTRY.registerWorker(MASTER, address(paymaster));

        zap = new SwapAndSupplyZap(IWETH(WETH), ISwapRouter02(UNISWAP_ROUTER02), IAavePool(AAVE_POOL));

        // The user's account: an EOA delegated to the canonical Simple7702Account (as Kohaku does).
        vm.signAndAttachDelegation(SIMPLE_7702, userKey);
    }

    function test_liveDao_canonicalPool_softwareDeployedWorker() public {
        // Live DAO state, untouched: the pool is enabled with the DAO's protocol fee.
        (,, uint8 state,, uint32 protocolFee) = INSTANCE_REGISTRY.instances(address(POOL));
        assertEq(state, 1, "ETH-100 pool enabled by the DAO");
        assertGt(protocolFee, 0, "DAO protocol fee set");
        assertEq(REGISTRY.workers(address(paymaster)), MASTER, "worker of the real master");
        assertEq(REGISTRY.workers(MASTER), MASTER);
        uint256 masterStakeBefore = REGISTRY.getRelayerBalance(MASTER);
        assertGt(masterStakeBefore, 0);

        // Shield: a fresh note into the canonical pool; the proof is built against its real tree.
        (commitment, root, nullifierHash, proof) = _prove(POOL.nextIndex(), user, MASTER, fee);
        address depositor = makeAddr("depositor");
        vm.deal(depositor, 101 ether);
        vm.prank(depositor);
        POOL.deposit{value: 100 ether}(commitment);
        assertTrue(POOL.isKnownRoot(root), "local tree matches the pool after the deposit");

        PackedUserOperation memory op = _sponsoredOp();

        uint256 masterEthBefore = MASTER.balance;
        uint256 depositBefore = paymaster.getDeposit();
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        ENTRY_POINT.handleOps(ops, beneficiary);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The DAO's economics, unchanged: the real FeeManager fee burned from the real master's stake.
        uint256 burned = _stakeBurned(logs);
        assertEq(burned, uint256(FEE_MANAGER.instanceFee(address(POOL))), "StakeBurned == FeeManager.instanceFee");
        assertGt(burned, 100e18, "ETH-100 at 0.30 % is >100 TORN");
        assertEq(REGISTRY.getRelayerBalance(MASTER), masterStakeBefore - burned);
        assertEq(MASTER.balance, masterEthBefore + fee, "fee to the master, as today");
        assertTrue(POOL.isSpent(nullifierHash));

        // The relay went through the router; gas came from the worker's deposit; nothing refunded.
        assertTrue(_relayedViaRouter(logs), "Relayed(viaRouter = true)");
        assertLt(paymaster.getDeposit(), depositBefore);
        assertEq(address(paymaster).balance, 0);
        assertEq(user.balance, 0, "sender keeps nothing");

        // The tail ran atomically: aUSDC on the final recipient.
        address aUsdc = IAavePoolData(AAVE_POOL).getReserveData(USDC).aTokenAddress;
        uint256 aBal = IERC20(aUsdc).balanceOf(finalRecipient);
        assertGt(aBal, 200_000e6, "100 ETH minus fee, swapped into USDC and supplied");
        emit log_named_uint("TORN burned (wei)", burned);
        emit log_named_uint("fee to master (wei)", fee);
        emit log_named_uint("aUSDC to recipient", aBal);
    }

    /// ERC-7562 storage rules, checked with the state-diff recorder: during validation the paymaster
    /// touches only its own storage (allowed for a staked paymaster) — no other contract's slots.
    /// Opcode rules (no BALANCE / GAS / TIMESTAMP …) are not observable here; they are covered by the
    /// reference-bundler trace in client/scripts/erc7562-check.ts.
    function test_liveDao_validationTouchesOnlyOwnStorage() public {
        (commitment, root, nullifierHash, proof) = _prove(POOL.nextIndex(), user, MASTER, fee);
        PackedUserOperation memory op = _sponsoredOp();
        bytes32 userOpHash = ENTRY_POINT.getUserOpHash(op);
        vm.startStateDiffRecording();
        vm.prank(address(ENTRY_POINT));
        paymaster.validatePaymasterUserOp(op, userOpHash, 0);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        uint256 storageOps;
        for (uint256 i = 0; i < accesses.length; i++) {
            for (uint256 j = 0; j < accesses[i].storageAccesses.length; j++) {
                storageOps++;
                assertEq(accesses[i].storageAccesses[j].account, address(paymaster), "validation touched foreign storage");
            }
            // No calls to anything but the paymaster itself (precompiles and the forge cheatcode VM excluded).
            // The one other account touched is the sender, whose code (the EIP-7702 delegation designator)
            // the paymaster reads to enforce the sponsored implementation — an EXTCODE read, never a call.
            if (accesses[i].account > address(0x100) && accesses[i].account != address(vm)) {
                if (accesses[i].account == user) {
                    assertTrue(
                        accesses[i].kind == VmSafe.AccountAccessKind.Extcodesize
                            || accesses[i].kind == VmSafe.AccountAccessKind.Extcodecopy
                            || accesses[i].kind == VmSafe.AccountAccessKind.Extcodehash,
                        "validation may only read the sender's code"
                    );
                    continue;
                }
                assertEq(accesses[i].account, address(paymaster), "validation called a foreign contract");
            }
        }
        assertGt(storageOps, 0, "expected the verifyingSigner read / transient writes");
    }

    /// Nobody can burn the master's stake through the worker without the relayer's signature.
    function test_liveDao_relayWithoutSponsorshipReverts() public {
        bytes32 wh = paymaster.withdrawalHash(POOL, hex"", bytes32(0), keccak256("x"), user, MASTER, 0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.NotSponsored.selector, user, wh));
        paymaster.relayWithdraw(POOL, hex"", bytes32(0), keccak256("x"), payable(user), payable(MASTER), 0);
    }

    /// The sponsorship binds the implementation that executes the op. The relayer signed for a sender
    /// running the canonical Simple7702Account; if the user then re-delegates the same EOA to another
    /// implementation (same code at another address, i.e. a valid authorization that only swaps the
    /// implementation), validation rejects the op and nothing is burned.
    function test_liveDao_reDelegationAfterSponsorshipRejected() public {
        (commitment, root, nullifierHash, proof) = _prove(POOL.nextIndex(), user, MASTER, fee);
        address depositor = makeAddr("depositor");
        vm.deal(depositor, 101 ether);
        vm.prank(depositor);
        POOL.deposit{value: 100 ether}(commitment);
        PackedUserOperation memory op = _sponsoredOp(); // relayer-signed with senderImplementation = SIMPLE_7702
        uint256 masterStakeBefore = REGISTRY.getRelayerBalance(MASTER);

        address otherImplementation = makeAddr("other Simple7702Account deployment");
        vm.etch(otherImplementation, SIMPLE_7702.code);
        vm.signAndAttachDelegation(otherImplementation, userKey);
        assertEq(user.code, abi.encodePacked(hex"ef0100", otherImplementation), "sender now runs the other implementation");

        bytes memory reason =
            abi.encodeWithSelector(TornadoRelayerPaymasterCore.SenderImplementationMismatch.selector, user, SIMPLE_7702);
        bytes32 userOpHash = ENTRY_POINT.getUserOpHash(op);
        vm.prank(address(ENTRY_POINT));
        vm.expectRevert(reason);
        paymaster.validatePaymasterUserOp(op, userOpHash, 0);

        // Through the EntryPoint: the op fails validation ("AA33 reverted"), the stake is untouched.
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA33 reverted", reason));
        ENTRY_POINT.handleOps(ops, beneficiary);
        assertEq(REGISTRY.getRelayerBalance(MASTER), masterStakeBefore, "no burn");
        assertFalse(POOL.isSpent(nullifierHash), "note not spent");

        // Back on the canonical implementation the very same signed op goes through.
        vm.signAndAttachDelegation(SIMPLE_7702, userKey);
        ENTRY_POINT.handleOps(ops, beneficiary);
        assertTrue(POOL.isSpent(nullifierHash), "note spent once re-delegated to the sponsored implementation");
    }

    // ------------------------------------------------------------ helpers

    /// The sponsored operation: relayWithdraw (relayer = master) then swap -> Aave for the recipient,
    /// signed by the relayer (worker mode, bound to exactly this relayWithdraw) and by the user.
    function _sponsoredOp() internal view returns (PackedUserOperation memory op) {
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({
            target: address(paymaster),
            value: 0,
            data: abi.encodeCall(
                TornadoRelayerPaymasterCore.relayWithdraw,
                (POOL, proof, root, nullifierHash, payable(user), payable(MASTER), fee)
            )
        });
        calls[1] = BaseAccount.Call({
            target: address(zap),
            value: 100 ether - fee,
            data: abi.encodeCall(SwapAndSupplyZap.swapEthAndSupply, (USDC, 500, 0, finalRecipient))
        });
        op.sender = user;
        op.nonce = ENTRY_POINT.getNonce(user, 0);
        op.callData = abi.encodeCall(BaseAccount.executeBatch, (calls));
        op.accountGasLimits = bytes32((uint256(150_000) << 128) | uint256(1_200_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(30 gwei));

        TornadoRelayerPaymasterCore.Terms memory t = _terms();
        op.paymasterAndData = _encode(t, new bytes(65));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(relayerKey, MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, t)));
        op.paymasterAndData = _encode(t, abi.encodePacked(r, s, v));
        (v, r, s) = vm.sign(userKey, ENTRY_POINT.getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
    }

    function _terms() internal view returns (TornadoRelayerPaymasterCore.Terms memory) {
        return TornadoRelayerPaymasterCore.Terms({
            validUntil: uint48(block.timestamp + 300),
            validAfter: 0,
            fee: fee,
            serviceFee: 0,
            refundTo: address(0),
            feeToken: address(0),
            tokenPerEth: 0,
            withdrawalHash: paymaster.withdrawalHash(POOL, proof, root, nullifierHash, user, MASTER, fee),
            senderImplementation: SIMPLE_7702 // the sender must run the canonical Simple7702Account
        });
    }

    function _prove(uint32 nextIndex, address recipient, address relayerAddr, uint256 fee_)
        internal
        returns (bytes32 commitment, bytes32 root, bytes32 nullifierHash, bytes memory proof)
    {
        string[] memory cmd = new string[](9);
        cmd[0] = "npx";
        cmd[1] = "tsx";
        cmd[2] = "../client/scripts/ffi-prove.ts";
        cmd[3] = LEAVES_FIXTURE;
        cmd[4] = vm.toString(FORK_BLOCK);
        cmd[5] = vm.toString(uint256(nextIndex));
        cmd[6] = vm.toString(recipient);
        cmd[7] = vm.toString(relayerAddr);
        cmd[8] = vm.toString(fee_);
        bytes memory out = vm.ffi(cmd);
        (commitment, root, nullifierHash, proof) = abi.decode(out, (bytes32, bytes32, bytes32, bytes));
    }

    function _encode(TornadoRelayerPaymasterCore.Terms memory t, bytes memory sig) internal view returns (bytes memory) {
        bytes memory head =
            abi.encodePacked(address(paymaster), uint128(100_000), uint128(90_000), t.validUntil, t.validAfter, t.fee, t.serviceFee);
        bytes memory tail = abi.encodePacked(t.refundTo, t.feeToken, t.tokenPerEth, t.withdrawalHash, t.senderImplementation);
        return bytes.concat(head, tail, sig);
    }

    function _stakeBurned(Vm.Log[] memory logs) internal pure returns (uint256 amount) {
        bytes32 sig = keccak256("StakeBurned(address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(REGISTRY) && logs[i].topics[0] == sig) {
                (, amount) = abi.decode(logs[i].data, (address, uint256));
                return amount;
            }
        }
        revert("StakeBurned not emitted");
    }

    function _relayedViaRouter(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == TornadoRelayerPaymasterCore.Relayed.selector) {
                (, bool viaRouter) = abi.decode(logs[i].data, (uint256, bool));
                return viaRouter;
            }
        }
        return false;
    }
}
