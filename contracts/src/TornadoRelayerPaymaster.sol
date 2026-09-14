// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasePaymaster} from "@account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title TornadoRelayerPaymaster
/// @notice ERC-4337 (EntryPoint v0.8) paymaster for a *thin* Tornado Cash relayer.
///
/// The relayer never submits transactions. Off-chain it inspects a userOp whose
/// callData performs `ITornadoInstance.withdraw(...)` with `relayer == address(this)`
/// and a `fee` that covers the sponsored gas, then signs the userOp together with
/// (validUntil, validAfter, fee, serviceFee, refundTo). On-chain, validation only
/// checks that signature: it touches no external storage, so the paymaster needs
/// no stake and validation stays cheap.
///
/// During execution the Tornado instance pays `fee` wei to this contract. In
/// `postOp` the paymaster keeps `actualGasCost * (1 + gasMarginBps) + serviceFee`,
/// refunds the remainder to `refundTo`, and re-deposits what it kept into the
/// EntryPoint so sponsorship is self-funding.
///
/// paymasterAndData layout (offsets in bytes):
///   [0:20]    paymaster address                (EntryPoint convention)
///   [20:36]   paymasterVerificationGasLimit    (EntryPoint convention)
///   [36:52]   paymasterPostOpGasLimit          (EntryPoint convention)
///   [52:58]   uint48 validUntil
///   [58:64]   uint48 validAfter
///   [64:96]   uint256 fee          (wei the withdraw pays this contract; must equal the callData fee)
///   [96:128]  uint256 serviceFee   (wei the relayer keeps on top of gas)
///   [128:148] address refundTo     (receives fee - gas - serviceFee; address(0) = no refund)
///   [148:213] bytes signature      (65 bytes, EIP-191 over getHash(...))
contract TornadoRelayerPaymaster is BasePaymaster {
    uint256 private constant VALID_UNTIL_OFFSET = PAYMASTER_DATA_OFFSET; // 52
    uint256 private constant VALID_AFTER_OFFSET = VALID_UNTIL_OFFSET + 6; // 58
    uint256 private constant FEE_OFFSET = VALID_AFTER_OFFSET + 6; // 64
    uint256 private constant SERVICE_FEE_OFFSET = FEE_OFFSET + 32; // 96
    uint256 private constant REFUND_TO_OFFSET = SERVICE_FEE_OFFSET + 32; // 128
    uint256 private constant SIGNATURE_OFFSET = REFUND_TO_OFFSET + 20; // 148
    uint256 public constant PAYMASTER_AND_DATA_LENGTH = SIGNATURE_OFFSET + 65; // 213

    uint256 public constant BPS = 10_000;
    /// @dev gas forwarded to `refundTo`; enough for an EOA / Simple7702Account receive().
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
        bytes32 indexed userOpHash, address indexed refundTo, uint256 fee, uint256 actualGasCost, uint256 refund
    );
    event SponsoredOpReverted(bytes32 indexed userOpHash, uint256 actualGasCost);
    event FeeNotReceived(bytes32 indexed userOpHash, uint256 expectedFee);
    event RefundFailed(bytes32 indexed userOpHash, address indexed refundTo, uint256 amount);
    event DepositFailed(bytes32 indexed userOpHash, uint256 amount);

    error InvalidPaymasterDataLength(uint256 actual, uint256 expected);
    error ZeroAddress();

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

    /// @dev Receives the Tornado relayer fee during the execution phase.
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

    // ---------------------------------------------------------------- hashing

    /// @notice Hash the relayer signs. Mirrors VerifyingPaymaster.getHash plus the fee terms.
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter,
        uint256 fee,
        uint256 serviceFee,
        address refundTo
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _userOpFieldsHash(userOp), block.chainid, address(this), validUntil, validAfter, fee, serviceFee, refundTo
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
        returns (
            uint48 validUntil,
            uint48 validAfter,
            uint256 fee,
            uint256 serviceFee,
            address refundTo,
            bytes calldata signature
        )
    {
        if (paymasterAndData.length != PAYMASTER_AND_DATA_LENGTH) {
            revert InvalidPaymasterDataLength(paymasterAndData.length, PAYMASTER_AND_DATA_LENGTH);
        }
        validUntil = uint48(bytes6(paymasterAndData[VALID_UNTIL_OFFSET:VALID_AFTER_OFFSET]));
        validAfter = uint48(bytes6(paymasterAndData[VALID_AFTER_OFFSET:FEE_OFFSET]));
        fee = uint256(bytes32(paymasterAndData[FEE_OFFSET:SERVICE_FEE_OFFSET]));
        serviceFee = uint256(bytes32(paymasterAndData[SERVICE_FEE_OFFSET:REFUND_TO_OFFSET]));
        refundTo = address(bytes20(paymasterAndData[REFUND_TO_OFFSET:SIGNATURE_OFFSET]));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    // ---------------------------------------------------------------- 4337 hooks

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        (uint48 validUntil, uint48 validAfter, uint256 fee, uint256 serviceFee, address refundTo, bytes calldata sig)
        = parsePaymasterAndData(userOp.paymasterAndData);

        bytes32 digest =
            MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter, fee, serviceFee, refundTo));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != verifyingSigner;

        // The context is returned even when the signature is invalid so that bundler
        // gas estimation (which runs with a dummy signature) exercises postOp.
        context = abi.encode(userOpHash, fee, serviceFee, refundTo);
        validationData = _packValidationData(sigFailed, validUntil, validAfter);
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        internal
        override
    {
        (bytes32 userOpHash, uint256 fee, uint256 serviceFee, address refundTo) =
            abi.decode(context, (bytes32, uint256, uint256, address));

        if (mode != PostOpMode.opSucceeded) {
            // Execution reverted, so the withdraw never paid us. The gas is our loss;
            // the relayer's pre-signing simulation is what keeps this rare.
            emit SponsoredOpReverted(userOpHash, actualGasCost);
            return;
        }

        uint256 balance = address(this).balance;
        if (balance == 0) {
            emit FeeNotReceived(userOpHash, fee);
            return;
        }

        uint256 gasCost = actualGasCost + postOpGasOverhead * actualUserOpFeePerGas;
        uint256 keep = gasCost + (gasCost * gasMarginBps) / BPS + serviceFee;
        uint256 refund = 0;
        if (refundTo != address(0) && fee > keep) {
            refund = fee - keep;
            if (refund > balance) refund = balance;
            (bool ok,) = refundTo.call{value: refund, gas: REFUND_GAS}("");
            if (ok) {
                balance -= refund;
            } else {
                emit RefundFailed(userOpHash, refundTo, refund);
                refund = 0;
            }
        }

        if (balance > 0) {
            try entryPoint.depositTo{value: balance}(address(this)) {}
            catch {
                emit DepositFailed(userOpHash, balance);
            }
        }

        emit Sponsored(userOpHash, refundTo, fee, actualGasCost, refund);
    }
}
