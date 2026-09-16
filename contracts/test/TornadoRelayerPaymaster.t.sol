// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "@account-abstraction/accounts/SimpleAccount.sol";
import {SimpleAccountFactory} from "@account-abstraction/accounts/SimpleAccountFactory.sol";
import {BaseAccount} from "@account-abstraction/core/BaseAccount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {TornadoRelayerPaymaster} from "../src/TornadoRelayerPaymaster.sol";
import {TornadoRelayerPaymasterCore} from "../src/TornadoRelayerPaymasterCore.sol";
import {TornadoRelayerPaymaster7702} from "../src/TornadoRelayerPaymaster7702.sol";
import {ITornadoInstance} from "../src/interfaces/ITornadoInstance.sol";
import {MockTornado, MockTornadoERC20, MockERC20} from "./mocks/MockTornado.sol";
import {MockRelayerRegistry, MockTornadoRouter} from "./mocks/MockRegistry.sol";
import {IRelayerRegistry, ITornadoRouter} from "../src/interfaces/ITornadoRouter.sol";

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

/// A note owner's helper contract: it is the proof's recipient, so it passes the recipient check.
contract RecipientProxy {
    function pull(TornadoRelayerPaymasterCore pm, address pool, bytes32 nh, address relayer) external {
        pm.relayWithdraw(ITornadoInstance(pool), hex"", bytes32(0), nh, payable(address(this)), payable(relayer), 0);
    }

    receive() external payable {}
}

contract TornadoRelayerPaymasterTest is Test {
    uint256 constant DENOMINATION = 0.1 ether;
    uint256 constant TOKEN_DENOMINATION = 100e18; // 100 DAI
    uint256 constant TOKEN_PER_ETH = 3000e18; // 3000 DAI per ETH
    uint256 constant GAS_MARGIN_BPS = 1_000; // 10%
    uint256 constant POST_OP_OVERHEAD = 40_000;
    uint256 constant MIN_STAKE = 5_000e18; // mainnet minStakeAmount
    uint256 constant BURN_PER_WITHDRAW = 1.1375e18; // ~ mainnet ETH-1 instanceFee at the time of writing

    EntryPoint entryPoint;
    SimpleAccountFactory factory;
    SimpleAccount account;
    MockTornado tornado;
    MockERC20 dai;
    MockTornadoERC20 tornadoDai;
    TornadoRelayerPaymaster paymaster;
    MockERC20 torn;
    MockRelayerRegistry registry;
    MockTornadoRouter router;

    uint256 relayerKey = 0xA11CE;
    address relayerSigner = vm.addr(relayerKey);
    uint256 ownerKey = 0xB0B;
    address owner = vm.addr(ownerKey);
    address finalRecipient = makeAddr("finalRecipient");
    address payable beneficiary = payable(makeAddr("bundler"));

    function setUp() public {
        entryPoint = new EntryPoint();
        factory = new SimpleAccountFactory(entryPoint);
        // v0.8 factories only accept calls from the EntryPoint's SenderCreator.
        vm.prank(address(entryPoint.senderCreator()));
        account = factory.createAccount(owner, 0);

        tornado = new MockTornado(DENOMINATION);
        vm.deal(address(tornado), 100 ether);

        dai = new MockERC20("Dai", "DAI", 18);
        tornadoDai = new MockTornadoERC20(dai, TOKEN_DENOMINATION);
        dai.mint(address(tornadoDai), 1_000_000e18);

        paymaster = new TornadoRelayerPaymaster(entryPoint, relayerSigner, GAS_MARGIN_BPS, POST_OP_OVERHEAD);
        paymaster.deposit{value: 5 ether}();

        torn = new MockERC20("Tornado", "TORN", 18);
        registry = new MockRelayerRegistry(torn, MIN_STAKE, BURN_PER_WITHDRAW);
        router = new MockTornadoRouter(registry);
        registry.setTornadoRouter(address(router));
    }

    /// Register the paymaster as a relayer master (owner owns the ENS name, holds the stake).
    function _registerPaymasterAsMaster() internal {
        paymaster.setRouter(ITornadoRouter(address(router)));
        torn.mint(address(paymaster), MIN_STAKE);
        paymaster.registerAsRelayer(IRelayerRegistry(address(registry)), "thin-relayer.eth", MIN_STAKE);
    }

    // ------------------------------------------------------------ helpers

    function _withdrawCall(address instance, bytes32 nullifierHash, uint256 fee)
        internal
        view
        returns (BaseAccount.Call memory)
    {
        return _relayCall(instance, nullifierHash, address(paymaster), fee);
    }

    /// The sponsoring call: `paymaster.relayWithdraw(pool, ..., recipient = account, relayer, fee)`.
    function _relayCall(address instance, bytes32 nullifierHash, address relayer, uint256 fee)
        internal
        view
        returns (BaseAccount.Call memory)
    {
        return BaseAccount.Call({
            target: address(paymaster),
            value: 0,
            data: abi.encodeCall(
                TornadoRelayerPaymasterCore.relayWithdraw,
                (
                    ITornadoInstance(instance),
                    hex"",
                    bytes32(0),
                    nullifierHash,
                    payable(address(account)),
                    payable(relayer),
                    fee
                )
            )
        });
    }

    function _baseOp(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.nonce = entryPoint.getNonce(address(account), 0);
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(200_000) << 128) | uint256(300_000)); // verification | call
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(20 gwei)); // priority | maxFee
    }

    function _pmPrefix() internal view returns (bytes memory) {
        return abi.encodePacked(address(paymaster), uint128(100_000), uint128(80_000));
    }

    /// An EIP-7702 initCode is hashed like the EntryPoint hashes it (delegate ‖ initCode[20:]), so the
    /// relayer's signature holds whether a bundler sends the bare `0x7702` marker or the 20-byte form.
    function test_getHash_eip7702InitCode_independentOfMarkerPadding() public {
        address sender7702 = makeAddr("eip7702 sender");
        address impl = makeAddr("implementation");
        vm.etch(sender7702, abi.encodePacked(hex"ef0100", impl));
        TornadoRelayerPaymasterCore.Terms memory t = _terms(1 ether, 0, address(0), address(0), 0);
        t.senderImplementation = impl;
        PackedUserOperation memory op;
        op.sender = sender7702;
        op.nonce = 5;
        op.callData = hex"deadbeef";
        op.accountGasLimits = bytes32((uint256(1) << 128) | 2);
        op.preVerificationGas = 3;
        op.gasFees = bytes32((uint256(4) << 128) | 5);
        op.paymasterAndData = _encode(t, new bytes(65));

        op.initCode = hex"7702";
        bytes32 bare = paymaster.getHash(op, t);
        op.initCode = abi.encodePacked(bytes20(hex"7702"));
        assertEq(paymaster.getHash(op, t), bare, "padded marker hashes like the bare one");
        op.initCode = abi.encodePacked(bytes20(hex"7702"), hex"abcd");
        assertTrue(paymaster.getHash(op, t) != bare, "factoryData is part of the hash");
        op.initCode = hex"";
        assertTrue(paymaster.getHash(op, t) != bare, "a non-7702 op hashes its raw initCode");
        // The delegate is what gets hashed: another implementation at the sender changes the hash.
        op.initCode = hex"7702";
        vm.etch(sender7702, abi.encodePacked(hex"ef0100", makeAddr("other")));
        assertTrue(paymaster.getHash(op, t) != bare, "delegate is part of the hash");
    }

    function _encode(TornadoRelayerPaymasterCore.Terms memory t, bytes memory sig) internal view returns (bytes memory) {
        return _encodeFor(address(paymaster), t, sig);
    }

    /// paymasterAndData for an arbitrary paymaster address (the 7702 test's worker EOA).
    function _encodeFor(address pm, TornadoRelayerPaymasterCore.Terms memory t, bytes memory sig)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory head = abi.encodePacked(pm, uint128(100_000), uint128(80_000), t.validUntil, t.validAfter, t.fee, t.serviceFee);
        bytes memory tail = abi.encodePacked(t.refundTo, t.feeToken, t.tokenPerEth, t.withdrawalHash, t.senderImplementation);
        return bytes.concat(head, tail, sig);
    }

    /// Hash of the relayWithdraw call `_relayCall` builds (empty proof, zero root).
    function _wh(address instance, bytes32 nullifierHash, address relayer, uint256 fee) internal view returns (bytes32) {
        return keccak256(abi.encode(ITornadoInstance(instance), keccak256(hex""), bytes32(0), nullifierHash, address(account), relayer, fee));
    }

    function _attachPaymaster(PackedUserOperation memory op, TornadoRelayerPaymasterCore.Terms memory t, uint256 signerKey)
        internal
        view
    {
        op.paymasterAndData = _encode(t, new bytes(65));
        bytes32 h = paymaster.getHash(op, t);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = _encode(t, abi.encodePacked(r, s, v));
    }

    function _terms(uint256 fee, uint256 serviceFee, address refundTo, address feeToken, uint256 rate)
        internal
        view
        returns (TornadoRelayerPaymasterCore.Terms memory)
    {
        return _termsFor(fee, serviceFee, refundTo, feeToken, rate, bytes32(0));
    }

    function _termsFor(uint256 fee, uint256 serviceFee, address refundTo, address feeToken, uint256 rate, bytes32 wh)
        internal
        view
        returns (TornadoRelayerPaymasterCore.Terms memory)
    {
        return TornadoRelayerPaymasterCore.Terms({
            validUntil: uint48(block.timestamp + 300),
            validAfter: uint48(block.timestamp > 0 ? block.timestamp - 1 : 0),
            fee: fee,
            serviceFee: serviceFee,
            refundTo: refundTo,
            feeToken: feeToken,
            tokenPerEth: rate,
            withdrawalHash: wh,
            senderImplementation: address(0)
        });
    }

    function _signAccount(PackedUserOperation memory op) internal view {
        bytes32 h = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, h);
        op.signature = abi.encodePacked(r, s, v);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, beneficiary);
    }

    /// ETH note: withdraw pays the paymaster, remainder forwarded to finalRecipient.
    function _ethOp(uint256 fee, uint256 serviceFee, address refundTo)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes32 nh = keccak256(abi.encode("eth", fee, serviceFee, refundTo));
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = _withdrawCall(address(tornado), nh, fee);
        calls[1] = BaseAccount.Call({target: finalRecipient, value: DENOMINATION - fee, data: ""});
        op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        bytes32 wh = _wh(address(tornado), nh, address(paymaster), fee);
        _attachPaymaster(op, _termsFor(fee, serviceFee, refundTo, address(0), 0, wh), relayerKey);
        _signAccount(op);
    }

    /// DAI note: withdraw pays the paymaster in DAI, remainder transferred to finalRecipient.
    function _daiOp(uint256 fee, uint256 serviceFee, address refundTo)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes32 nh = keccak256(abi.encode("dai", fee, serviceFee, refundTo));
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = _withdrawCall(address(tornadoDai), nh, fee);
        calls[1] = BaseAccount.Call({
            target: address(dai),
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (finalRecipient, TOKEN_DENOMINATION - fee))
        });
        op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        bytes32 wh = _wh(address(tornadoDai), nh, address(paymaster), fee);
        _attachPaymaster(op, _termsFor(fee, serviceFee, refundTo, address(dai), TOKEN_PER_ETH, wh), relayerKey);
        _signAccount(op);
    }

    // ------------------------------------------------------------ tests

    function test_layoutConstants() public view {
        assertEq(paymaster.PAYMASTER_AND_DATA_LENGTH(), 317);
    }

    function test_parsePaymasterAndData_roundTrip() public view {
        bytes memory sig = new bytes(65);
        sig[0] = 0xAA;
        TornadoRelayerPaymasterCore.Terms memory t = _termsFor(7 ether, 0.01 ether, finalRecipient, address(dai), 123456, keccak256("wh"));
        t.validUntil = 1234;
        t.validAfter = 56;
        (TornadoRelayerPaymasterCore.Terms memory p, bytes memory s) = paymaster.parsePaymasterAndData(_encode(t, sig));
        assertEq(p.validUntil, 1234);
        assertEq(p.validAfter, 56);
        assertEq(p.fee, 7 ether);
        assertEq(p.serviceFee, 0.01 ether);
        assertEq(p.refundTo, finalRecipient);
        assertEq(p.feeToken, address(dai));
        assertEq(p.tokenPerEth, 123456);
        assertEq(p.withdrawalHash, keccak256("wh"));
        assertEq(p.senderImplementation, address(0));
        assertEq(s.length, 65);
        assertEq(uint8(s[0]), 0xAA);
    }

    function test_parsePaymasterAndData_rejectsWrongLength() public {
        bytes memory data = abi.encodePacked(_pmPrefix(), uint48(1), uint48(0));
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.InvalidPaymasterDataLength.selector, 64, 317));
        paymaster.parsePaymasterAndData(data);
    }

    /// ETH happy path: withdraw pays the paymaster, the excess is refunded, the rest is re-deposited.
    function test_eth_sponsoredWithdraw_refundsExcessAndRedeposits() public {
        uint256 fee = 0.02 ether;
        uint256 serviceFee = 0.001 ether;
        PackedUserOperation memory op = _ethOp(fee, serviceFee, address(account));

        uint256 depositBefore = paymaster.getDeposit();
        uint256 accountBefore = address(account).balance;

        vm.recordLogs();
        _handle(op);

        assertEq(finalRecipient.balance, DENOMINATION - fee);
        assertEq(address(paymaster).balance, 0);

        (address feeToken, uint256 actualGasCost, uint256 refund) = _findSponsored(vm.getRecordedLogs());
        assertEq(feeToken, address(0));
        assertGt(actualGasCost, 0);
        assertGt(refund, 0);
        assertEq(address(account).balance, accountBefore + refund);

        uint256 depositAfter = paymaster.getDeposit();
        uint256 kept = fee - refund;
        assertLt(depositAfter, depositBefore + kept, "deposit must reflect gas paid");
        assertGt(depositAfter, depositBefore, "paymaster should profit from margin + serviceFee");
        uint256 gasPaid = depositBefore + kept - depositAfter;
        assertGe(kept, gasPaid + serviceFee);
    }

    /// ERC-20 happy path: fee arrives in DAI, refund is paid in DAI at the signed rate, deposit only shrinks by gas.
    function test_erc20_sponsoredWithdraw_refundsInToken() public {
        // Quote: ~700k gas * 20 gwei = 0.014 ETH -> 42 DAI at 3000 DAI/ETH, plus service fee 0.3 DAI.
        uint256 fee = 45e18;
        uint256 serviceFee = 0.3e18;
        PackedUserOperation memory op = _daiOp(fee, serviceFee, finalRecipient);

        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (address feeToken, uint256 actualGasCost, uint256 refund) = _findSponsored(logs);
        assertEq(feeToken, address(dai));
        assertGt(refund, 0);

        // Recipient: denomination - fee (forwarded by the account) + refund (from postOp).
        assertEq(dai.balanceOf(finalRecipient), TOKEN_DENOMINATION - fee + refund);
        // Paymaster keeps fee - refund in DAI, which must cover gas at the signed rate plus the service fee.
        uint256 keptToken = fee - refund;
        assertEq(dai.balanceOf(address(paymaster)), keptToken);
        uint256 gasPaidEth = depositBefore - paymaster.getDeposit();
        uint256 gasPaidToken = (gasPaidEth * TOKEN_PER_ETH) / 1e18;
        assertGe(keptToken, gasPaidToken + serviceFee);
        // Deposit only paid for gas; no ETH was received.
        assertEq(address(paymaster).balance, 0);
        assertLt(paymaster.getDeposit(), depositBefore);
    }

    function test_erc20_feeBelowKeep_noRefund() public {
        uint256 fee = 0.05e18; // below the ~1 DAI gas cost at the signed rate
        PackedUserOperation memory op = _daiOp(fee, 0, finalRecipient);
        vm.recordLogs();
        _handle(op);
        (, , uint256 refund) = _findSponsored(vm.getRecordedLogs());
        assertEq(refund, 0);
        assertEq(dai.balanceOf(address(paymaster)), fee);
    }

    function test_erc20_sweep() public {
        PackedUserOperation memory op = _daiOp(45e18, 0, address(0));
        _handle(op);
        uint256 held = dai.balanceOf(address(paymaster));
        assertEq(held, 45e18);
        address treasury = makeAddr("treasury");
        paymaster.sweepERC20(dai, treasury, held);
        assertEq(dai.balanceOf(treasury), held);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        paymaster.sweepERC20(dai, treasury, 1);
    }

    function test_refundTargetZero_keepsEverything() public {
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _ethOp(fee, 0, address(0));
        uint256 depositBefore = paymaster.getDeposit();

        vm.recordLogs();
        _handle(op);

        (,, uint256 refund) = _findSponsored(vm.getRecordedLogs());
        assertEq(refund, 0);
        assertEq(address(paymaster).balance, 0);
        assertGt(paymaster.getDeposit(), depositBefore);
    }

    function test_refundFailure_isKeptAndDeposited() public {
        RejectsEth rejecter = new RejectsEth();
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _ethOp(fee, 0, address(rejecter));

        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(_sawEvent(logs, TornadoRelayerPaymasterCore.RefundFailed.selector), "RefundFailed expected");
        (,, uint256 refund) = _findSponsored(logs);
        assertEq(refund, 0, "refund must be reported as 0 when it fails");
        assertEq(address(rejecter).balance, 0);
        assertEq(address(paymaster).balance, 0);
        assertGt(paymaster.getDeposit(), depositBefore);
    }

    function test_wrongSigner_rejectedAA34() public {
        uint256 fee = 0.02 ether;
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = _withdrawCall(address(tornado), keccak256("x"), fee);
        PackedUserOperation memory op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        _attachPaymaster(op, _terms(fee, 0, address(0), address(0), 0), 0xDEAD);
        _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    function test_expired_rejectedAA32() public {
        uint256 fee = 0.02 ether;
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = _withdrawCall(address(tornado), keccak256("y"), fee);
        PackedUserOperation memory op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        vm.warp(1_000_000);
        TornadoRelayerPaymasterCore.Terms memory t = _terms(fee, 0, address(0), address(0), 0);
        t.validUntil = uint48(block.timestamp - 1);
        t.validAfter = 0;
        _attachPaymaster(op, t, relayerKey);
        _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _handle(op);
    }

    function test_tamperedRate_invalidatesSignature() public {
        PackedUserOperation memory op = _daiOp(45e18, 0, finalRecipient);
        // Flip a byte of the signed tokenPerEth field without re-signing.
        bytes memory pd = op.paymasterAndData;
        pd[168 + 31] = bytes1(uint8(pd[168 + 31]) ^ 0x01);
        op.paymasterAndData = pd;
        _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// Execution reverts (e.g. nullifier already spent): paymaster pays gas, receives nothing, no refund.
    function test_executionRevert_paymasterEatsGasOnly() public {
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _ethOp(fee, 0, address(account));
        tornado.setFailWithdraw(true);

        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);

        assertEq(finalRecipient.balance, 0);
        assertEq(address(paymaster).balance, 0);
        assertLt(paymaster.getDeposit(), depositBefore);
        assertTrue(_sawEvent(vm.getRecordedLogs(), TornadoRelayerPaymasterCore.SponsoredOpReverted.selector));
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        paymaster.setVerifyingSigner(makeAddr("x"));

        paymaster.setVerifyingSigner(makeAddr("newSigner"));
        assertEq(paymaster.verifyingSigner(), makeAddr("newSigner"));
        paymaster.setGasMarginBps(500);
        assertEq(paymaster.gasMarginBps(), 500);

        vm.expectRevert(TornadoRelayerPaymasterCore.OnlySelf.selector);
        paymaster.refundToken(dai, finalRecipient, 1);
    }

    // ------------------------------------------------------------ router / registry

    /// Master mode: the paymaster is a registered relayer; every sponsored withdrawal burns TORN
    /// from its stake via Router -> RelayerRegistry.burn, the fee still lands on the paymaster.
    function test_router_masterMode_burnsPaymasterStake() public {
        _registerPaymasterAsMaster();
        assertEq(registry.workers(address(paymaster)), address(paymaster));
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE);

        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _ethOp(fee, 0.001 ether, address(account));
        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE - BURN_PER_WITHDRAW, "stake burned");
        assertEq(registry.totalBurned(), BURN_PER_WITHDRAW);
        assertEq(finalRecipient.balance, DENOMINATION - fee);
        (,, uint256 refund) = _findSponsored(logs);
        assertGt(refund, 0, "master mode still refunds");
        assertGt(paymaster.getDeposit(), depositBefore, "fee re-deposited");
        assertTrue(_sawEvent(logs, TornadoRelayerPaymasterCore.Relayed.selector));
    }

    /// Worker mode: an existing relayer registers the paymaster as a worker. The proof names the
    /// master, so the fee goes to the master (classic economics, no refund); the burn hits the
    /// master's stake; the paymaster's deposit only pays the gas.
    function test_router_workerMode_feeToMaster_burnsMasterStake() public {
        address master = makeAddr("existingRelayer");
        torn.mint(master, MIN_STAKE);
        vm.startPrank(master);
        torn.approve(address(registry), MIN_STAKE);
        registry.register("existing-relayer.eth", MIN_STAKE, new address[](0));
        registry.registerWorker(master, address(paymaster));
        vm.stopPrank();
        paymaster.setRouter(ITornadoRouter(address(router)));
        assertEq(registry.workers(address(paymaster)), master);

        uint256 fee = 0.02 ether;
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = _relayCall(address(tornado), keccak256("worker"), master, fee);
        calls[1] = BaseAccount.Call({target: finalRecipient, value: DENOMINATION - fee, data: ""});
        PackedUserOperation memory op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        bytes32 wh = _wh(address(tornado), keccak256("worker"), master, fee);
        _attachPaymaster(op, _termsFor(fee, 0, address(0), address(0), 0, wh), relayerKey); // refundTo = 0
        _signAccount(op);

        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(master.balance, fee, "fee paid to the master EOA");
        assertEq(finalRecipient.balance, DENOMINATION - fee);
        assertEq(registry.getRelayerBalance(master), MIN_STAKE - BURN_PER_WITHDRAW, "master stake burned");
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE - BURN_PER_WITHDRAW, "worker resolves to master");
        assertEq(address(paymaster).balance, 0);
        assertLt(paymaster.getDeposit(), depositBefore, "deposit paid the gas");
        (,, uint256 refund) = _findSponsored(logs);
        assertEq(refund, 0);
        assertFalse(_sawEvent(logs, TornadoRelayerPaymasterCore.FeeNotReceived.selector), "no refund promised, no warning");
    }

    /// Registry rule: a registered worker may only relay for its own master.
    function test_router_workerMode_wrongRelayerReverts() public {
        address master = makeAddr("existingRelayer");
        torn.mint(master, MIN_STAKE);
        vm.startPrank(master);
        torn.approve(address(registry), MIN_STAKE);
        registry.register("existing-relayer.eth", MIN_STAKE, new address[](0));
        registry.registerWorker(master, address(paymaster));
        vm.stopPrank();
        paymaster.setRouter(ITornadoRouter(address(router)));

        _sponsor(address(account), _wh(address(tornado), keccak256("z"), address(paymaster), 0.01 ether));
        vm.prank(address(account));
        vm.expectRevert("only relayer");
        paymaster.relayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("z"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
    }

    /// What the EntryPoint does before execution: validate the op, which grants `sender` exactly `wh`.
    function _sponsor(address sender, bytes32 wh) internal {
        PackedUserOperation memory op;
        op.sender = sender;
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), new bytes(148), wh, new bytes(20), new bytes(65));
        vm.prank(address(entryPoint));
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    /// Audit finding: without the allowance a note owner could route fee-0 withdrawals through the
    /// paymaster (via a contract recipient) and burn the relayer's stake for free.
    function test_relayWithdraw_requiresSponsorship() public {
        _registerPaymasterAsMaster();
        RecipientProxy proxy = new RecipientProxy();
        bytes32 freeHash = keccak256(abi.encode(ITornadoInstance(address(tornado)), keccak256(hex""), bytes32(0), keccak256("free"), address(proxy), address(paymaster), uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.NotSponsored.selector, address(proxy), freeHash));
        proxy.pull(paymaster, address(tornado), keccak256("free"), address(paymaster));
        assertEq(registry.totalBurned(), 0);

        // One validation = exactly one approved relay, even for the legitimate sender: a different
        // note (or a different fee / relayer) than the one the relayer signed is refused.
        bytes32 approved = _wh(address(tornado), keccak256("one"), address(paymaster), 0.01 ether);
        _sponsor(address(account), approved);
        assertEq(paymaster.sponsorshipAllowance(address(account), approved), 1);
        vm.startPrank(address(account));
        bytes32 other = _wh(address(tornado), keccak256("two"), address(paymaster), 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.NotSponsored.selector, address(account), other));
        paymaster.relayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("two"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
        bytes32 cheaper = _wh(address(tornado), keccak256("one"), address(paymaster), 0);
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.NotSponsored.selector, address(account), cheaper));
        paymaster.relayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("one"), payable(address(account)),
            payable(address(paymaster)), 0
        );
        paymaster.relayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("one"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
        assertEq(paymaster.sponsorshipAllowance(address(account), approved), 0);
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.NotSponsored.selector, address(account), approved));
        paymaster.relayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("one"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
        vm.stopPrank();
        assertEq(registry.totalBurned(), BURN_PER_WITHDRAW);
    }

    /// The relayer's pre-signing dry run: reverts with the inner result and leaves no trace.
    function test_simulateRelayWithdraw_dryRunRevertsWithResult() public {
        _registerPaymasterAsMaster();
        bytes memory ok = abi.encodeWithSelector(TornadoRelayerPaymasterCore.SimulationResult.selector, true, bytes(""));
        vm.expectRevert(ok);
        paymaster.simulateRelayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("sim"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
        assertEq(registry.totalBurned(), 0, "dry run must not persist");
        assertFalse(tornado.isSpent(keccak256("sim")));

        // Failures are reported, not swallowed: wrong relayer for a registered master.
        bytes memory inner = abi.encodeWithSignature("Error(string)", "only relayer");
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.SimulationResult.selector, false, inner));
        paymaster.simulateRelayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("sim2"), payable(address(account)),
            payable(makeAddr("someone")), 0.01 ether
        );
        // The inner step is not callable directly.
        vm.expectRevert(TornadoRelayerPaymasterCore.OnlySelf.selector);
        paymaster.relayWithdrawSimulated(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("sim3"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
    }

    /// The sponsorship names the account implementation the sender must run. A client that obtains a
    /// signature while delegated to A and then re-authorizes to its own B (re-signing the userOp with
    /// the same key) is refused at validation: the paymaster reads the sender's delegation designator.
    function test_senderImplementation_boundAtValidation() public {
        _registerPaymasterAsMaster();
        uint256 eoaKey = 0xACC0;
        address eoa = vm.addr(eoaKey);
        address implA = address(new SimpleAccount(entryPoint)); // stands in for Simple7702Account
        address implB = address(new SimpleAccount(entryPoint)); // the attacker's own implementation

        vm.signAndAttachDelegation(implA, eoaKey);
        assertEq(eoa.code.length, 23);
        bytes32 wh = keccak256(abi.encode(ITornadoInstance(address(tornado)), keccak256(hex""), bytes32(0), keccak256("d"), eoa, address(paymaster), uint256(0.01 ether)));
        TornadoRelayerPaymasterCore.Terms memory t = _termsFor(0.01 ether, 0, eoa, address(0), 0, wh);
        t.senderImplementation = implA;

        PackedUserOperation memory op;
        op.sender = eoa;
        op.paymasterAndData = _encode(t, new bytes(65));
        bytes32 h = paymaster.getHash(op, t);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(relayerKey, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = _encode(t, abi.encodePacked(r, s_, v));

        // Delegated to A: validation accepts (signature valid).
        vm.prank(address(entryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(uint160(validationData), 0, "sig ok while delegated to the approved implementation");

        // Same signed op, sender re-delegated to B before submission: refused.
        vm.signAndAttachDelegation(implB, eoaKey);
        vm.prank(address(entryPoint));
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymasterCore.SenderImplementationMismatch.selector, eoa, implA));
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);

        // And the terms cannot be edited to B without breaking the relayer's signature.
        t.senderImplementation = implB;
        op.paymasterAndData = _encode(t, abi.encodePacked(r, s_, v));
        vm.prank(address(entryPoint));
        (, validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(uint160(validationData), 1, "tampered terms -> sig failed");
    }

    /// EIP-7702: an existing relayer's worker EOA delegates to the shared implementation and *is* the
    /// paymaster. The registry already knows it as a worker, so nothing changes on the DAO side.
    function test_7702_workerEoaIsThePaymaster() public {
        uint256 workerKey = 0x7702;
        address worker = vm.addr(workerKey);
        address master = makeAddr("existingRelayer");
        torn.mint(master, MIN_STAKE);
        vm.startPrank(master);
        torn.approve(address(registry), MIN_STAKE);
        registry.register("existing-relayer.eth", MIN_STAKE, new address[](0));
        registry.registerWorker(master, worker); // the worker the relayer already runs today
        vm.stopPrank();

        TornadoRelayerPaymaster7702 impl =
            new TornadoRelayerPaymaster7702(entryPoint, ITornadoRouter(address(router)), GAS_MARGIN_BPS, POST_OP_OVERHEAD);
        vm.signAndAttachDelegation(address(impl), workerKey);
        TornadoRelayerPaymaster7702 pm = TornadoRelayerPaymaster7702(payable(worker));
        assertEq(pm.owner(), worker);
        assertEq(pm.verifyingSigner(), worker);
        assertEq(address(pm.router()), address(router));

        // Setup the relayer software does at boot: self-calls from the worker key.
        vm.deal(worker, 10 ether);
        vm.startPrank(worker);
        pm.addStake{value: 0.1 ether}(1 days);
        pm.deposit{value: 2 ether}();
        vm.stopPrank();

        // A sponsored op: proof names the master, callData calls worker.relayWithdraw.
        uint256 fee = 0.02 ether;
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({
            target: worker,
            value: 0,
            data: abi.encodeCall(
                TornadoRelayerPaymasterCore.relayWithdraw,
                (ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("7702"), payable(address(account)), payable(master), fee)
            )
        });
        calls[1] = BaseAccount.Call({target: finalRecipient, value: DENOMINATION - fee, data: ""});
        PackedUserOperation memory op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        TornadoRelayerPaymasterCore.Terms memory t =
            _termsFor(fee, 0, address(0), address(0), 0, _wh(address(tornado), keccak256("7702"), master, fee));
        op.paymasterAndData = _encodeFor(worker, t, new bytes(65));
        bytes32 h = pm.getHash(op, t);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(workerKey, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData = _encodeFor(worker, t, abi.encodePacked(r, s_, v));
        _signAccount(op);

        uint256 depositBefore = pm.getDeposit();
        _handle(op);

        assertEq(master.balance, fee, "fee to the existing relayer's master");
        assertEq(finalRecipient.balance, DENOMINATION - fee);
        assertEq(registry.getRelayerBalance(master), MIN_STAKE - BURN_PER_WITHDRAW, "master stake burned");
        assertLt(pm.getDeposit(), depositBefore, "worker's deposit paid the gas");
        assertEq(worker.balance, 10 ether - 0.1 ether - 2 ether, "worker EOA balance untouched otherwise");
    }

    /// Only the note's recipient may trigger the relay (no one else can burn the relayer's stake).
    function test_relayWithdraw_onlyRecipient() public {
        _registerPaymasterAsMaster();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(TornadoRelayerPaymasterCore.OnlyRecipient.selector);
        paymaster.relayWithdraw(
            ITornadoInstance(address(tornado)), hex"", bytes32(0), keccak256("q"), payable(address(account)),
            payable(address(paymaster)), 0.01 ether
        );
    }

    /// Without a router (testnets) the paymaster calls the pool directly and no registry is involved.
    function test_relayWithdraw_directWhenNoRouter() public {
        assertEq(address(paymaster.router()), address(0));
        PackedUserOperation memory op = _ethOp(0.02 ether, 0, address(account));
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(finalRecipient.balance, DENOMINATION - 0.02 ether);
        assertEq(registry.totalBurned(), 0);
        bool sawDirect;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == TornadoRelayerPaymasterCore.Relayed.selector) {
                (, bool viaRouter) = abi.decode(logs[i].data, (uint256, bool));
                sawDirect = !viaRouter;
            }
        }
        assertTrue(sawDirect, "Relayed(viaRouter=false) expected");
    }

    function test_registerAsRelayer_andAdminCall_onlyOwner() public {
        torn.mint(address(paymaster), MIN_STAKE * 2);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        paymaster.registerAsRelayer(IRelayerRegistry(address(registry)), "thin-relayer.eth", MIN_STAKE);

        paymaster.registerAsRelayer(IRelayerRegistry(address(registry)), "thin-relayer.eth", MIN_STAKE);
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE);
        assertEq(torn.balanceOf(address(registry)), MIN_STAKE);

        // Housekeeping through adminCall: add the operator's hot wallet as a worker, top up the stake.
        address hotWallet = makeAddr("hotWallet");
        paymaster.adminCall(
            address(registry), 0, abi.encodeCall(MockRelayerRegistry.registerWorker, (address(paymaster), hotWallet))
        );
        assertEq(registry.workers(hotWallet), address(paymaster));
        paymaster.adminCall(address(torn), 0, abi.encodeCall(IERC20.approve, (address(registry), MIN_STAKE)));
        paymaster.adminCall(
            address(registry), 0, abi.encodeCall(MockRelayerRegistry.stakeToRelayer, (address(paymaster), MIN_STAKE))
        );
        assertEq(registry.getRelayerBalance(address(paymaster)), MIN_STAKE * 2);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        paymaster.adminCall(address(torn), 0, abi.encodeCall(IERC20.approve, (address(registry), 1)));

        vm.expectRevert(
            abi.encodeWithSelector(
                TornadoRelayerPaymasterCore.AdminCallFailed.selector, abi.encodeWithSignature("Error(string)", "!registered")
            )
        );
        paymaster.adminCall(
            address(registry), 0, abi.encodeCall(MockRelayerRegistry.stakeToRelayer, (hotWallet, 1))
        );
    }

    // ------------------------------------------------------------ log helpers

    function _findSponsored(Vm.Log[] memory logs)
        internal
        view
        returns (address feeToken, uint256 actualGasCost, uint256 refund)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == TornadoRelayerPaymasterCore.Sponsored.selector)
            {
                feeToken = address(uint160(uint256(logs[i].topics[3])));
                (, actualGasCost, refund) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return (feeToken, actualGasCost, refund);
            }
        }
        revert("Sponsored not emitted");
    }

    function _sawEvent(Vm.Log[] memory logs, bytes32 selector) internal view returns (bool) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == selector) return true;
        }
        return false;
    }
}
