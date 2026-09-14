// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "@account-abstraction/accounts/SimpleAccount.sol";
import {SimpleAccountFactory} from "@account-abstraction/accounts/SimpleAccountFactory.sol";
import {BaseAccount} from "@account-abstraction/core/BaseAccount.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {TornadoRelayerPaymaster} from "../src/TornadoRelayerPaymaster.sol";
import {ITornadoInstance} from "../src/interfaces/ITornadoInstance.sol";
import {MockTornado} from "./mocks/MockTornado.sol";

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

contract TornadoRelayerPaymasterTest is Test {
    uint256 constant DENOMINATION = 0.1 ether;
    uint256 constant GAS_MARGIN_BPS = 1_000; // 10%
    uint256 constant POST_OP_OVERHEAD = 40_000;

    EntryPoint entryPoint;
    SimpleAccountFactory factory;
    SimpleAccount account;
    MockTornado tornado;
    TornadoRelayerPaymaster paymaster;

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

        paymaster = new TornadoRelayerPaymaster(entryPoint, relayerSigner, GAS_MARGIN_BPS, POST_OP_OVERHEAD);
        paymaster.deposit{value: 5 ether}();
    }

    // ------------------------------------------------------------ helpers

    function _withdrawCall(bytes32 nullifierHash, uint256 fee) internal view returns (BaseAccount.Call memory) {
        return BaseAccount.Call({
            target: address(tornado),
            value: 0,
            data: abi.encodeCall(
                ITornadoInstance.withdraw,
                (hex"", bytes32(0), nullifierHash, payable(address(account)), payable(address(paymaster)), fee, 0)
            )
        });
    }

    function _forwardCall(uint256 amount) internal view returns (BaseAccount.Call memory) {
        return BaseAccount.Call({target: finalRecipient, value: amount, data: ""});
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

    function _attachPaymaster(
        PackedUserOperation memory op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 fee,
        uint256 serviceFee,
        address refundTo,
        uint256 signerKey
    ) internal view {
        op.paymasterAndData = abi.encodePacked(_pmPrefix(), validUntil, validAfter, fee, serviceFee, refundTo, new bytes(65));
        bytes32 h = paymaster.getHash(op, validUntil, validAfter, fee, serviceFee, refundTo);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, MessageHashUtils.toEthSignedMessageHash(h));
        op.paymasterAndData =
            abi.encodePacked(_pmPrefix(), validUntil, validAfter, fee, serviceFee, refundTo, abi.encodePacked(r, s, v));
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

    function _sponsoredOp(uint256 fee, uint256 serviceFee, address refundTo)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = _withdrawCall(keccak256(abi.encode(fee, serviceFee, refundTo)), fee);
        calls[1] = _forwardCall(DENOMINATION - fee);
        op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        _attachPaymaster(
            op, uint48(block.timestamp + 300), uint48(block.timestamp - 1), fee, serviceFee, refundTo, relayerKey
        );
        _signAccount(op);
    }

    // ------------------------------------------------------------ tests

    function test_layoutConstants() public view {
        assertEq(paymaster.PAYMASTER_AND_DATA_LENGTH(), 213);
    }

    function test_parsePaymasterAndData_roundTrip() public view {
        bytes memory sig = new bytes(65);
        sig[0] = 0xAA;
        bytes memory data = abi.encodePacked(
            _pmPrefix(), uint48(1234), uint48(56), uint256(7 ether), uint256(0.01 ether), finalRecipient, sig
        );
        (uint48 vu, uint48 va, uint256 fee, uint256 sfee, address refundTo, bytes memory s) =
            paymaster.parsePaymasterAndData(data);
        assertEq(vu, 1234);
        assertEq(va, 56);
        assertEq(fee, 7 ether);
        assertEq(sfee, 0.01 ether);
        assertEq(refundTo, finalRecipient);
        assertEq(s.length, 65);
        assertEq(uint8(s[0]), 0xAA);
    }

    function test_parsePaymasterAndData_rejectsWrongLength() public {
        bytes memory data = abi.encodePacked(_pmPrefix(), uint48(1), uint48(0));
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymaster.InvalidPaymasterDataLength.selector, 64, 213));
        paymaster.parsePaymasterAndData(data);
    }

    /// Full happy path: withdraw pays the paymaster, the excess is refunded, the rest is re-deposited.
    function test_sponsoredWithdraw_refundsExcessAndRedeposits() public {
        uint256 fee = 0.02 ether;
        uint256 serviceFee = 0.001 ether;
        PackedUserOperation memory op = _sponsoredOp(fee, serviceFee, address(account));

        uint256 depositBefore = paymaster.getDeposit();
        uint256 accountBefore = address(account).balance;

        vm.recordLogs();
        _handle(op);

        // Final recipient got denomination - fee.
        assertEq(finalRecipient.balance, DENOMINATION - fee);

        // Paymaster holds nothing outside the EntryPoint.
        assertEq(address(paymaster).balance, 0);

        // Decode Sponsored event to get the actual gas cost and refund.
        (uint256 actualGasCost, uint256 refund) = _findSponsored(vm.getRecordedLogs());
        assertGt(actualGasCost, 0);
        assertGt(refund, 0);

        // Refund landed on the sender account.
        assertEq(address(account).balance, accountBefore + refund);

        // Deposit accounting: - total gas charged + (fee - refund).
        // The EntryPoint charges actualGasCost plus the postOp gas; we only know a lower bound exactly.
        uint256 depositAfter = paymaster.getDeposit();
        uint256 kept = fee - refund;
        assertLt(depositAfter, depositBefore + kept, "deposit must reflect gas paid");
        // The margin plus overhead must leave the paymaster net-positive on the op.
        assertGt(depositAfter, depositBefore, "paymaster should profit from margin + serviceFee");
        // Everything kept above gas must be at least the service fee.
        uint256 gasPaid = depositBefore + kept - depositAfter;
        assertGe(kept, gasPaid + serviceFee);
    }

    function test_refundTargetZero_keepsEverything() public {
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _sponsoredOp(fee, 0, address(0));
        uint256 depositBefore = paymaster.getDeposit();

        vm.recordLogs();
        _handle(op);

        (, uint256 refund) = _findSponsored(vm.getRecordedLogs());
        assertEq(refund, 0);
        assertEq(address(paymaster).balance, 0);
        assertGt(paymaster.getDeposit(), depositBefore);
    }

    function test_refundFailure_isKeptAndDeposited() public {
        RejectsEth rejecter = new RejectsEth();
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _sponsoredOp(fee, 0, address(rejecter));

        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(_sawEvent(logs, TornadoRelayerPaymaster.RefundFailed.selector), "RefundFailed expected");
        (, uint256 refund) = _findSponsored(logs);
        assertEq(refund, 0, "refund must be reported as 0 when it fails");
        assertEq(address(rejecter).balance, 0);
        // The whole fee is kept and re-deposited.
        assertEq(address(paymaster).balance, 0);
        assertGt(paymaster.getDeposit(), depositBefore);
    }

    function test_wrongSigner_rejectedAA34() public {
        uint256 fee = 0.02 ether;
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = _withdrawCall(keccak256("x"), fee);
        PackedUserOperation memory op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        _attachPaymaster(op, uint48(block.timestamp + 300), 0, fee, 0, address(0), 0xDEAD);
        _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    function test_expired_rejectedAA32() public {
        uint256 fee = 0.02 ether;
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = _withdrawCall(keccak256("y"), fee);
        PackedUserOperation memory op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        vm.warp(1_000_000);
        _attachPaymaster(op, uint48(block.timestamp - 1), 0, fee, 0, address(0), relayerKey);
        _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due"));
        _handle(op);
    }

    function test_tamperedFee_invalidatesSignature() public {
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _sponsoredOp(fee, 0, address(0));
        // Flip the signed fee field in paymasterData without re-signing.
        bytes memory pd = op.paymasterAndData;
        pd[64 + 31] = bytes1(uint8(pd[64 + 31]) ^ 0x01);
        op.paymasterAndData = pd;
        _signAccount(op);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _handle(op);
    }

    /// Execution reverts (e.g. nullifier already spent): paymaster pays gas, receives nothing, no refund.
    function test_executionRevert_paymasterEatsGasOnly() public {
        uint256 fee = 0.02 ether;
        PackedUserOperation memory op = _sponsoredOp(fee, 0, address(account));
        tornado.setFailWithdraw(true);

        uint256 depositBefore = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);

        assertEq(finalRecipient.balance, 0);
        assertEq(address(paymaster).balance, 0);
        assertLt(paymaster.getDeposit(), depositBefore);
        assertTrue(_sawEvent(vm.getRecordedLogs(), TornadoRelayerPaymaster.SponsoredOpReverted.selector));
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        paymaster.setVerifyingSigner(makeAddr("x"));

        paymaster.setVerifyingSigner(makeAddr("newSigner"));
        assertEq(paymaster.verifyingSigner(), makeAddr("newSigner"));
        paymaster.setGasMarginBps(500);
        assertEq(paymaster.gasMarginBps(), 500);
    }

    // ------------------------------------------------------------ log helpers

    function _findSponsored(Vm.Log[] memory logs) internal view returns (uint256 actualGasCost, uint256 refund) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == TornadoRelayerPaymaster.Sponsored.selector)
            {
                (, actualGasCost, refund) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return (actualGasCost, refund);
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
