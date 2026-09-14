// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasePaymaster} from "@account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/core/Helpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title TornadoRelayerPaymaster
/// @notice ERC-4337 (EntryPoint v0.8) paymaster for a *thin* Tornado Cash relayer.
///
/// The relayer never submits transactions. Off-chain it inspects a userOp whose
/// callData performs `ITornadoInstance.withdraw(...)` with `relayer == address(this)`
/// and a `fee` that covers the sponsored gas, then signs the userOp together with
/// the fee terms below. On-chain, validation only checks that signature: it touches
/// no external storage, so the paymaster needs no stake and validation stays cheap.
///
/// During execution the Tornado instance pays `fee` to this contract — in ETH for
/// ETH instances, in the pool token for ERC-20 instances. In `postOp` the paymaster
/// keeps `actualGasCost * (1 + gasMarginBps)` (converted with the relayer-signed
/// `tokenPerEth` rate for tokens) plus `serviceFee`, refunds the remainder to
/// `refundTo`, and — for ETH — re-deposits what it kept into the EntryPoint so
/// sponsorship is self-funding. Tokens accumulate in the contract for the operator
/// to sweep and convert.
///
/// paymasterAndData layout (offsets in bytes):
///   [0:20]    paymaster address                (EntryPoint convention)
///   [20:36]   paymasterVerificationGasLimit    (EntryPoint convention)
///   [36:52]   paymasterPostOpGasLimit          (EntryPoint convention)
///   [52:58]   uint48  validUntil
///   [58:64]   uint48  validAfter
///   [64:96]   uint256 fee          (feeToken units the withdraw pays this contract; must equal the callData fee)
///   [96:128]  uint256 serviceFee   (feeToken units the relayer keeps on top of gas)
///   [128:148] address refundTo     (receives fee - gas - serviceFee; address(0) = no refund)
///   [148:168] address feeToken     (address(0) = ETH instance)
///   [168:200] uint256 tokenPerEth  (feeToken units per 1e18 wei; ignored for ETH)
///   [200:265] bytes   signature    (65 bytes, EIP-191 over getHash(...))
contract TornadoRelayerPaymaster is BasePaymaster {
    using SafeERC20 for IERC20;

    struct Terms {
        uint48 validUntil;
        uint48 validAfter;
        uint256 fee;
        uint256 serviceFee;
        address refundTo;
        address feeToken;
        uint256 tokenPerEth;
    }

    uint256 private constant VALID_UNTIL_OFFSET = PAYMASTER_DATA_OFFSET; // 52
    uint256 private constant VALID_AFTER_OFFSET = VALID_UNTIL_OFFSET + 6; // 58
    uint256 private constant FEE_OFFSET = VALID_AFTER_OFFSET + 6; // 64
    uint256 private constant SERVICE_FEE_OFFSET = FEE_OFFSET + 32; // 96
    uint256 private constant REFUND_TO_OFFSET = SERVICE_FEE_OFFSET + 32; // 128
    uint256 private constant FEE_TOKEN_OFFSET = REFUND_TO_OFFSET + 20; // 148
    uint256 private constant TOKEN_PER_ETH_OFFSET = FEE_TOKEN_OFFSET + 20; // 168
    uint256 private constant SIGNATURE_OFFSET = TOKEN_PER_ETH_OFFSET + 32; // 200
    uint256 public constant PAYMASTER_AND_DATA_LENGTH = SIGNATURE_OFFSET + 65; // 265

    uint256 public constant BPS = 10_000;
    uint256 public constant RATE_SCALE = 1e18;
    /// @dev gas forwarded to `refundTo` for ETH refunds; enough for an EOA / Simple7702Account receive().
    uint256 public constant REFUND_GAS = 30_000;

    /// @notice Off-chain relayer key whose signature authorises sponsorship.
    address public verifyingSigner;
    /// @notice Margin kept on top of the actual gas cost, in basis points.
    uint256 public gasMarginBps;
    /// @notice Gas units charged for postOp itself (EntryPoint bills them after postOp runs).
    uint256 public postOpGasOverhead;

    event VerifyingSignerSet(address indexed signer);
    event GasMarginSet(uint256 gasMarginBps);
    event PostOpGasOverheadSet(uint256 postOpGasOverhead);
    event Sponsored(
        bytes32 indexed userOpHash,
        address indexed refundTo,
        address indexed feeToken,
        uint256 fee,
        uint256 actualGasCost,
        uint256 refund
    );
    event SponsoredOpReverted(bytes32 indexed userOpHash, uint256 actualGasCost);
    event FeeNotReceived(bytes32 indexed userOpHash, address indexed feeToken, uint256 expectedFee);
    event RefundFailed(bytes32 indexed userOpHash, address indexed refundTo, address indexed feeToken, uint256 amount);
    event DepositFailed(bytes32 indexed userOpHash, uint256 amount);

    error InvalidPaymasterDataLength(uint256 actual, uint256 expected);
    error ZeroAddress();
    error OnlySelf();

    constructor(IEntryPoint _entryPoint, address _verifyingSigner, uint256 _gasMarginBps, uint256 _postOpGasOverhead)
        BasePaymaster(_entryPoint)
    {
        if (_verifyingSigner == address(0)) revert ZeroAddress();
        verifyingSigner = _verifyingSigner;
        gasMarginBps = _gasMarginBps;
        postOpGasOverhead = _postOpGasOverhead;
        emit VerifyingSignerSet(_verifyingSigner);
        emit GasMarginSet(_gasMarginBps);
        emit PostOpGasOverheadSet(_postOpGasOverhead);
    }

    /// @dev Receives the Tornado relayer fee of ETH instances during the execution phase.
    receive() external payable {}

    // ---------------------------------------------------------------- admin

    function setVerifyingSigner(address _verifyingSigner) external onlyOwner {
        if (_verifyingSigner == address(0)) revert ZeroAddress();
        verifyingSigner = _verifyingSigner;
        emit VerifyingSignerSet(_verifyingSigner);
    }

    function setGasMarginBps(uint256 _gasMarginBps) external onlyOwner {
        gasMarginBps = _gasMarginBps;
        emit GasMarginSet(_gasMarginBps);
    }

    function setPostOpGasOverhead(uint256 _postOpGasOverhead) external onlyOwner {
        postOpGasOverhead = _postOpGasOverhead;
        emit PostOpGasOverheadSet(_postOpGasOverhead);
    }

    /// @notice Move stray ETH held by the contract (fees of ops whose postOp could not deposit).
    function sweep(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "sweep failed");
    }

    /// @notice Move collected ERC-20 fees out (to be converted into ETH and re-deposited by the operator).
    function sweepERC20(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- hashing

    /// @notice Hash the relayer signs. Mirrors VerifyingPaymaster.getHash plus the fee terms.
    function getHash(PackedUserOperation calldata userOp, Terms memory terms) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _userOpFieldsHash(userOp),
                block.chainid,
                address(this),
                terms.validUntil,
                terms.validAfter,
                terms.fee,
                terms.serviceFee,
                terms.refundTo,
                terms.feeToken,
                terms.tokenPerEth
            )
        );
    }

    /// @dev Hash of every userOp field except paymasterData/signature (same set as VerifyingPaymaster).
    function _userOpFieldsHash(PackedUserOperation calldata userOp) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees
            )
        );
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (Terms memory terms, bytes calldata signature)
    {
        if (paymasterAndData.length != PAYMASTER_AND_DATA_LENGTH) {
            revert InvalidPaymasterDataLength(paymasterAndData.length, PAYMASTER_AND_DATA_LENGTH);
        }
        terms.validUntil = uint48(bytes6(paymasterAndData[VALID_UNTIL_OFFSET:VALID_AFTER_OFFSET]));
        terms.validAfter = uint48(bytes6(paymasterAndData[VALID_AFTER_OFFSET:FEE_OFFSET]));
        terms.fee = uint256(bytes32(paymasterAndData[FEE_OFFSET:SERVICE_FEE_OFFSET]));
        terms.serviceFee = uint256(bytes32(paymasterAndData[SERVICE_FEE_OFFSET:REFUND_TO_OFFSET]));
        terms.refundTo = address(bytes20(paymasterAndData[REFUND_TO_OFFSET:FEE_TOKEN_OFFSET]));
        terms.feeToken = address(bytes20(paymasterAndData[FEE_TOKEN_OFFSET:TOKEN_PER_ETH_OFFSET]));
        terms.tokenPerEth = uint256(bytes32(paymasterAndData[TOKEN_PER_ETH_OFFSET:SIGNATURE_OFFSET]));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    // ---------------------------------------------------------------- 4337 hooks

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        (Terms memory terms, bytes calldata sig) = parsePaymasterAndData(userOp.paymasterAndData);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, terms));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != verifyingSigner;

        // The context is returned even when the signature is invalid so that bundler
        // gas estimation (which runs with a dummy signature) exercises postOp.
        context = abi.encode(userOpHash, terms);
        validationData = _packValidationData(sigFailed, terms.validUntil, terms.validAfter);
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        internal
        override
    {
        (bytes32 userOpHash, Terms memory terms) = abi.decode(context, (bytes32, Terms));

        if (mode != PostOpMode.opSucceeded) {
            // Execution reverted, so the withdraw never paid us. The gas is our loss;
            // the relayer's pre-signing simulation is what keeps this rare.
            emit SponsoredOpReverted(userOpHash, actualGasCost);
            return;
        }

        uint256 gasCost = actualGasCost + postOpGasOverhead * actualUserOpFeePerGas;
        uint256 keepEth = gasCost + (gasCost * gasMarginBps) / BPS;

        if (terms.feeToken == address(0)) {
            _settleEth(userOpHash, terms, keepEth + terms.serviceFee, actualGasCost);
        } else {
            uint256 keepToken = (keepEth * terms.tokenPerEth) / RATE_SCALE + terms.serviceFee;
            _settleToken(userOpHash, terms, keepToken, actualGasCost);
        }
    }

    function _settleEth(bytes32 userOpHash, Terms memory terms, uint256 keep, uint256 actualGasCost) internal {
        uint256 balance = address(this).balance;
        if (balance == 0) {
            emit FeeNotReceived(userOpHash, address(0), terms.fee);
            return;
        }

        uint256 refund = 0;
        if (terms.refundTo != address(0) && terms.fee > keep) {
            refund = terms.fee - keep;
            if (refund > balance) refund = balance;
            (bool ok,) = terms.refundTo.call{value: refund, gas: REFUND_GAS}("");
            if (ok) {
                balance -= refund;
            } else {
                emit RefundFailed(userOpHash, terms.refundTo, address(0), refund);
                refund = 0;
            }
        }

        if (balance > 0) {
            try entryPoint.depositTo{value: balance}(address(this)) {}
            catch {
                emit DepositFailed(userOpHash, balance);
            }
        }

        emit Sponsored(userOpHash, terms.refundTo, address(0), terms.fee, actualGasCost, refund);
    }

    function _settleToken(bytes32 userOpHash, Terms memory terms, uint256 keep, uint256 actualGasCost) internal {
        IERC20 token = IERC20(terms.feeToken);
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) {
            emit FeeNotReceived(userOpHash, terms.feeToken, terms.fee);
            return;
        }

        uint256 refund = 0;
        if (terms.refundTo != address(0) && terms.fee > keep) {
            refund = terms.fee - keep;
            if (refund > balance) refund = balance;
            // External self-call so a misbehaving token cannot revert postOp.
            try this.refundToken(token, terms.refundTo, refund) {}
            catch {
                emit RefundFailed(userOpHash, terms.refundTo, terms.feeToken, refund);
                refund = 0;
            }
        }

        emit Sponsored(userOpHash, terms.refundTo, terms.feeToken, terms.fee, actualGasCost, refund);
    }

    /// @dev Only callable by the contract itself (see _settleToken).
    function refundToken(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        token.safeTransfer(to, amount);
    }
}
