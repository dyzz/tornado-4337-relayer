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
import {ITornadoInstance} from "../src/interfaces/ITornadoInstance.sol";
import {MockTornado, MockTornadoERC20, MockERC20} from "./mocks/MockTornado.sol";

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

contract TornadoRelayerPaymasterTest is Test {
    uint256 constant DENOMINATION = 0.1 ether;
    uint256 constant TOKEN_DENOMINATION = 100e18; // 100 DAI
    uint256 constant TOKEN_PER_ETH = 3000e18; // 3000 DAI per ETH
    uint256 constant GAS_MARGIN_BPS = 1_000; // 10%
    uint256 constant POST_OP_OVERHEAD = 40_000;

    EntryPoint entryPoint;
    SimpleAccountFactory factory;
    SimpleAccount account;
    MockTornado tornado;
    MockERC20 dai;
    MockTornadoERC20 tornadoDai;
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

        dai = new MockERC20("Dai", "DAI", 18);
        tornadoDai = new MockTornadoERC20(dai, TOKEN_DENOMINATION);
        dai.mint(address(tornadoDai), 1_000_000e18);

        paymaster = new TornadoRelayerPaymaster(entryPoint, relayerSigner, GAS_MARGIN_BPS, POST_OP_OVERHEAD);
        paymaster.deposit{value: 5 ether}();
    }

    // ------------------------------------------------------------ helpers

    function _withdrawCall(address instance, bytes32 nullifierHash, uint256 fee)
        internal
        view
        returns (BaseAccount.Call memory)
    {
        return BaseAccount.Call({
            target: instance,
            value: 0,
            data: abi.encodeCall(
                ITornadoInstance.withdraw,
                (hex"", bytes32(0), nullifierHash, payable(address(account)), payable(address(paymaster)), fee, 0)
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

    function _encode(TornadoRelayerPaymaster.Terms memory t, bytes memory sig) internal view returns (bytes memory) {
        return abi.encodePacked(
            _pmPrefix(), t.validUntil, t.validAfter, t.fee, t.serviceFee, t.refundTo, t.feeToken, t.tokenPerEth, sig
        );
    }

    function _attachPaymaster(PackedUserOperation memory op, TornadoRelayerPaymaster.Terms memory t, uint256 signerKey)
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
        returns (TornadoRelayerPaymaster.Terms memory)
    {
        return TornadoRelayerPaymaster.Terms({
            validUntil: uint48(block.timestamp + 300),
            validAfter: uint48(block.timestamp > 0 ? block.timestamp - 1 : 0),
            fee: fee,
            serviceFee: serviceFee,
            refundTo: refundTo,
            feeToken: feeToken,
            tokenPerEth: rate
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
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = _withdrawCall(address(tornado), keccak256(abi.encode("eth", fee, serviceFee, refundTo)), fee);
        calls[1] = BaseAccount.Call({target: finalRecipient, value: DENOMINATION - fee, data: ""});
        op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        _attachPaymaster(op, _terms(fee, serviceFee, refundTo, address(0), 0), relayerKey);
        _signAccount(op);
    }

    /// DAI note: withdraw pays the paymaster in DAI, remainder transferred to finalRecipient.
    function _daiOp(uint256 fee, uint256 serviceFee, address refundTo)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = _withdrawCall(address(tornadoDai), keccak256(abi.encode("dai", fee, serviceFee, refundTo)), fee);
        calls[1] = BaseAccount.Call({
            target: address(dai),
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (finalRecipient, TOKEN_DENOMINATION - fee))
        });
        op = _baseOp(abi.encodeCall(BaseAccount.executeBatch, (calls)));
        _attachPaymaster(op, _terms(fee, serviceFee, refundTo, address(dai), TOKEN_PER_ETH), relayerKey);
        _signAccount(op);
    }

    // ------------------------------------------------------------ tests

    function test_layoutConstants() public view {
        assertEq(paymaster.PAYMASTER_AND_DATA_LENGTH(), 265);
    }

    function test_parsePaymasterAndData_roundTrip() public view {
        bytes memory sig = new bytes(65);
        sig[0] = 0xAA;
        TornadoRelayerPaymaster.Terms memory t = _terms(7 ether, 0.01 ether, finalRecipient, address(dai), 123456);
        t.validUntil = 1234;
        t.validAfter = 56;
        (TornadoRelayerPaymaster.Terms memory p, bytes memory s) = paymaster.parsePaymasterAndData(_encode(t, sig));
        assertEq(p.validUntil, 1234);
        assertEq(p.validAfter, 56);
        assertEq(p.fee, 7 ether);
        assertEq(p.serviceFee, 0.01 ether);
        assertEq(p.refundTo, finalRecipient);
        assertEq(p.feeToken, address(dai));
        assertEq(p.tokenPerEth, 123456);
        assertEq(s.length, 65);
        assertEq(uint8(s[0]), 0xAA);
    }

    function test_parsePaymasterAndData_rejectsWrongLength() public {
        bytes memory data = abi.encodePacked(_pmPrefix(), uint48(1), uint48(0));
        vm.expectRevert(abi.encodeWithSelector(TornadoRelayerPaymaster.InvalidPaymasterDataLength.selector, 64, 265));
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

        assertTrue(_sawEvent(logs, TornadoRelayerPaymaster.RefundFailed.selector), "RefundFailed expected");
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
        TornadoRelayerPaymaster.Terms memory t = _terms(fee, 0, address(0), address(0), 0);
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

        vm.expectRevert(TornadoRelayerPaymaster.OnlySelf.selector);
        paymaster.refundToken(dai, finalRecipient, 1);
    }

    // ------------------------------------------------------------ log helpers

    function _findSponsored(Vm.Log[] memory logs)
        internal
        view
        returns (address feeToken, uint256 actualGasCost, uint256 refund)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == TornadoRelayerPaymaster.Sponsored.selector)
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
