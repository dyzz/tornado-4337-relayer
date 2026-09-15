// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "@account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "@account-abstraction/core/UserOperationLib.sol";
import {_packValidationData} from "@account-abstraction/core/Helpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ITornadoInstance} from "./interfaces/ITornadoInstance.sol";
import {ITornadoRouter, IRelayerRegistry} from "./interfaces/ITornadoRouter.sol";

/// @title TornadoRelayerPaymasterCore
/// @notice ERC-4337 (EntryPoint v0.8) paymaster logic of a *thin* Tornado Cash relayer.
/// Two deployments share it:
///   - `TornadoRelayerPaymaster`      a standalone contract (owner = deployer);
///   - `TornadoRelayerPaymaster7702`  an EIP-7702 delegate: the relayer's existing *worker* EOA,
///                                    already registered in the DAO's RelayerRegistry, delegates
///                                    its code here and becomes the paymaster itself.
///
/// The relayer never submits transactions. Off-chain it inspects a userOp whose callData calls
/// `relayWithdraw(...)` on this contract with a `fee` that covers the sponsored gas, then signs the
/// userOp together with the fee terms below. On-chain, validation checks that signature and records
/// a one-shot *sponsorship allowance* for the sender in transient storage; `relayWithdraw` consumes
/// it, so a withdrawal can only be relayed (and the relayer's TORN stake burned) inside an operation
/// the relayer signed.
///
/// `relayWithdraw` forwards the withdrawal through the DAO's `TornadoRouter`, so this address is the
/// `msg.sender` the `RelayerRegistry` sees: it must be a registered relayer *master* or *worker*, and
/// the pool's TORN fee is burned from that stake exactly as for a classic relayer.
///
///   worker mode  proof binds `relayer = <master EOA>`: the fee goes to the master as today,
///                nothing is refunded (`refundTo = 0`, classic fixed fee); the EntryPoint deposit
///                pays the gas and the operator tops it up from earnings.
///   master mode  proof binds `relayer = address(this)`: the fee lands here; `postOp` keeps
///                `actualGasCost * (1 + gasMarginBps)` (converted at the signed `tokenPerEth` for
///                tokens) plus `serviceFee`, refunds the rest to `refundTo` and re-deposits ETH.
///
/// paymasterAndData layout (offsets in bytes):
///   [0:20]    paymaster address                (EntryPoint convention)
///   [20:36]   paymasterVerificationGasLimit    (EntryPoint convention)
///   [36:52]   paymasterPostOpGasLimit          (EntryPoint convention)
///   [52:58]   uint48  validUntil
///   [58:64]   uint48  validAfter
///   [64:96]   uint256 fee          (feeToken units the withdraw pays the relayer; must equal the callData fee)
///   [96:128]  uint256 serviceFee   (feeToken units the relayer keeps on top of gas)
///   [128:148] address refundTo     (receives fee - gas - serviceFee; address(0) = no refund)
///   [148:168] address feeToken     (address(0) = ETH instance)
///   [168:200] uint256 tokenPerEth  (feeToken units per 1e18 wei; ignored for ETH)
///   [200:265] bytes   signature    (65 bytes, EIP-191 over getHash(...))
abstract contract TornadoRelayerPaymasterCore is IPaymaster {
    using SafeERC20 for IERC20;
    using UserOperationLib for PackedUserOperation;

    struct Terms {
        uint48 validUntil;
        uint48 validAfter;
        uint256 fee;
        uint256 serviceFee;
        address refundTo;
        address feeToken;
        uint256 tokenPerEth;
    }

    uint256 private constant PAYMASTER_VALIDATION_GAS_OFFSET = UserOperationLib.PAYMASTER_VALIDATION_GAS_OFFSET; // 20
    uint256 private constant PAYMASTER_DATA_OFFSET = UserOperationLib.PAYMASTER_DATA_OFFSET; // 52
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
    /// @dev transient-storage namespaces: per-sender sponsorship allowance, and the fee `relayWithdraw`
    /// actually received for that sender (ETH and pool token), read back by postOp.
    bytes32 private constant SPONSORSHIP_SLOT_SEED = keccak256("tornado-4337-relayer.sponsorship");
    bytes32 private constant RECEIVED_ETH_SLOT_SEED = keccak256("tornado-4337-relayer.received.eth");
    bytes32 private constant RECEIVED_TOKEN_SLOT_SEED = keccak256("tornado-4337-relayer.received.token");

    IEntryPoint public immutable entryPoint;

    event VerifyingSignerSet(address indexed signer);
    event GasMarginSet(uint256 gasMarginBps);
    event PostOpGasOverheadSet(uint256 postOpGasOverhead);
    event RouterSet(address indexed router);
    event Relayed(address indexed pool, bytes32 indexed nullifierHash, address indexed relayer, uint256 fee, bool viaRouter);
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
    error OnlyOwner();
    error OnlyEntryPoint();
    error OnlyRecipient();
    /// @dev `relayWithdraw` called outside an operation this paymaster validated for `msg.sender`.
    error NotSponsored(address sender);
    error AdminCallFailed(bytes result);
    /// @dev Always thrown by `simulateRelayWithdraw`: `success` and the inner return / revert data.
    error SimulationResult(bool success, bytes result);

    constructor(IEntryPoint _entryPoint) {
        entryPoint = _entryPoint;
    }

    /// @dev Receives the Tornado relayer fee of ETH instances during the execution phase.
    receive() external payable {}

    // ---------------------------------------------------------------- parameters (deployment-specific)

    /// @notice Off-chain relayer key whose signature authorises sponsorship.
    function verifyingSigner() public view virtual returns (address);
    /// @notice Margin kept on top of the actual gas cost, in basis points (master mode).
    function gasMarginBps() public view virtual returns (uint256);
    /// @notice Gas units charged for postOp itself (EntryPoint bills them after postOp runs).
    function postOpGasOverhead() public view virtual returns (uint256);
    /// @notice DAO `TornadoRouter` withdrawals go through (RelayerRegistry burn). 0 = call pools directly.
    function router() public view virtual returns (ITornadoRouter);
    /// @notice Who may call the admin functions.
    function owner() public view virtual returns (address);

    modifier onlyOwner() {
        if (msg.sender != owner()) revert OnlyOwner();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Register this address as a Tornado relayer *master*: it must already own `ensName`
    /// (ENS `setOwner` / `setSubnodeOwner` to this address) and hold `stake` TORN.
    function registerAsRelayer(IRelayerRegistry registry, string calldata ensName, uint256 stake)
        external
        onlyOwner
    {
        IERC20(registry.torn()).forceApprove(address(registry), stake);
        registry.register(ensName, stake, new address[](0));
    }

    /// @notice Generic owner passthrough for relayer housekeeping that must originate from this
    /// address: ENS records of the relayer name, `registerWorker`, extra `stakeToRelayer`, ...
    function adminCall(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (bytes memory result)
    {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert AdminCallFailed(result);
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

    // ---------------------------------------------------------------- EntryPoint deposit / stake

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    /// @notice ERC-7562 lets a paymaster touch its own storage during validation only when staked.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    // ---------------------------------------------------------------- relaying

    /// @notice Execute a Tornado withdrawal as the registered relayer. Called by the userOp sender
    /// (the note's recipient) during the execution phase of an operation this paymaster validated.
    /// @dev Only the recipient may trigger it and only with a sponsorship allowance, so neither a
    /// third party nor the note owner can burn the relayer's stake without the relayer's signature.
    /// `refund` is always 0 (the sender is a contract account that needs no gas top-up).
    function relayWithdraw(
        ITornadoInstance pool,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee
    ) external {
        if (msg.sender != recipient) revert OnlyRecipient();
        _relayWithdraw(pool, proof, root, nullifierHash, recipient, relayer, fee);
    }

    /// @notice Dry-run of `relayWithdraw` for the relayer's pre-signing check (`eth_call` only): grants
    /// `recipient` a sponsorship, runs the relay, and always reverts with `SimulationResult`, so nothing
    /// persists. Proof, root, nullifier, registry state and the router path are all exercised.
    function simulateRelayWithdraw(
        ITornadoInstance pool,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee
    ) external {
        _grantSponsorship(recipient);
        (bool ok, bytes memory data) = address(this).call(
            abi.encodeCall(this.relayWithdrawSimulated, (pool, proof, root, nullifierHash, recipient, relayer, fee))
        );
        revert SimulationResult(ok, data);
    }

    /// @dev Inner step of `simulateRelayWithdraw`; only reachable through it (self-call), whose revert undoes it.
    function relayWithdrawSimulated(
        ITornadoInstance pool,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _relayWithdraw(pool, proof, root, nullifierHash, recipient, relayer, fee);
    }

    function _relayWithdraw(
        ITornadoInstance pool,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee
    ) internal {
        _consumeSponsorship(recipient);

        // Measure what this withdrawal pays us (master mode: the fee; worker mode: nothing), so postOp
        // settles exactly that and never touches ETH or tokens the address held beforehand — under
        // EIP-7702 the paymaster's balance is the relayer's own EOA balance.
        address token = _poolToken(pool);
        uint256 ethBefore = address(this).balance;
        uint256 tokenBefore = token == address(0) ? 0 : IERC20(token).balanceOf(address(this));

        ITornadoRouter r = router();
        bool viaRouter = address(r) != address(0);
        if (viaRouter) {
            r.withdraw(pool, proof, root, nullifierHash, recipient, relayer, fee, 0);
        } else {
            pool.withdraw(proof, root, nullifierHash, recipient, relayer, fee, 0);
        }

        _addReceived(RECEIVED_ETH_SLOT_SEED, recipient, address(this).balance - ethBefore);
        if (token != address(0)) {
            _addReceived(RECEIVED_TOKEN_SLOT_SEED, recipient, IERC20(token).balanceOf(address(this)) - tokenBefore);
        }
        emit Relayed(address(pool), nullifierHash, relayer, fee, viaRouter);
    }

    /// @dev ERC20Tornado exposes `token()`; ETHTornado does not.
    function _poolToken(ITornadoInstance pool) internal view returns (address token) {
        (bool ok, bytes memory data) = address(pool).staticcall(abi.encodeWithSelector(ITornadoInstance.token.selector));
        if (ok && data.length == 32) token = abi.decode(data, (address));
    }

    function _receivedSlot(bytes32 seed, address sender) internal pure returns (bytes32) {
        return keccak256(abi.encode(seed, sender));
    }

    function _addReceived(bytes32 seed, address sender, uint256 amount) internal {
        if (amount == 0) return;
        bytes32 slot = _receivedSlot(seed, sender);
        assembly ("memory-safe") {
            tstore(slot, add(tload(slot), amount))
        }
    }

    /// @dev Reads and clears the amount `relayWithdraw` collected for `sender` in this transaction.
    function _takeReceived(bytes32 seed, address sender) internal returns (uint256 amount) {
        bytes32 slot = _receivedSlot(seed, sender);
        assembly ("memory-safe") {
            amount := tload(slot)
            tstore(slot, 0)
        }
    }

    /// @notice Sponsorship allowances currently open for `sender` (transient; non-zero only inside a bundle).
    function sponsorshipAllowance(address sender) public view returns (uint256 allowance) {
        bytes32 slot = _sponsorshipSlot(sender);
        assembly ("memory-safe") {
            allowance := tload(slot)
        }
    }

    function _sponsorshipSlot(address sender) internal pure returns (bytes32) {
        return keccak256(abi.encode(SPONSORSHIP_SLOT_SEED, sender));
    }

    function _grantSponsorship(address sender) internal {
        bytes32 slot = _sponsorshipSlot(sender);
        assembly ("memory-safe") {
            tstore(slot, add(tload(slot), 1))
        }
    }

    function _consumeSponsorship(address sender) internal {
        bytes32 slot = _sponsorshipSlot(sender);
        uint256 allowance;
        assembly ("memory-safe") {
            allowance := tload(slot)
        }
        if (allowance == 0) revert NotSponsored(sender);
        assembly ("memory-safe") {
            tstore(slot, sub(allowance, 1))
        }
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

    /// @inheritdoc IPaymaster
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256)
        external
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        (Terms memory terms, bytes calldata sig) = parsePaymasterAndData(userOp.paymasterAndData);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, terms));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != verifyingSigner();

        // One relay per validated operation. Granted regardless of the signature so that bundler gas
        // estimation (dummy signature) exercises the execution path; an invalid signature never
        // reaches execution (AA34).
        _grantSponsorship(userOp.sender);

        // The context is returned even when the signature is invalid so estimation exercises postOp.
        context = abi.encode(userOpHash, userOp.sender, terms);
        validationData = _packValidationData(sigFailed, terms.validUntil, terms.validAfter);
    }

    /// @inheritdoc IPaymaster
    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
        onlyEntryPoint
    {
        (bytes32 userOpHash, address sender, Terms memory terms) = abi.decode(context, (bytes32, address, Terms));
        uint256 receivedEth = _takeReceived(RECEIVED_ETH_SLOT_SEED, sender);
        uint256 receivedToken = _takeReceived(RECEIVED_TOKEN_SLOT_SEED, sender);

        if (mode != PostOpMode.opSucceeded) {
            // Execution reverted, so the withdraw never paid us. The gas is our loss;
            // the relayer's pre-signing simulation is what keeps this rare.
            emit SponsoredOpReverted(userOpHash, actualGasCost);
            return;
        }

        uint256 gasCost = actualGasCost + postOpGasOverhead() * actualUserOpFeePerGas;
        uint256 keepEth = gasCost + (gasCost * gasMarginBps()) / BPS;

        if (terms.feeToken == address(0)) {
            _settleEth(userOpHash, terms, keepEth + terms.serviceFee, actualGasCost, receivedEth);
        } else {
            uint256 keepToken = (keepEth * terms.tokenPerEth) / RATE_SCALE + terms.serviceFee;
            _settleToken(userOpHash, terms, keepToken, actualGasCost, receivedToken);
        }
    }

    /// @dev `balance` is what this operation's relayWithdraw paid us; nothing else is touched.
    function _settleEth(bytes32 userOpHash, Terms memory terms, uint256 keep, uint256 actualGasCost, uint256 balance)
        internal
    {
        uint256 refund = 0;
        if (terms.refundTo != address(0)) {
            // A refund was promised, so the fee must have reached this contract (master mode).
            if (balance == 0) emit FeeNotReceived(userOpHash, address(0), terms.fee);
            if (terms.fee > keep) {
                refund = terms.fee - keep;
                if (refund > balance) refund = balance;
                if (refund > 0) {
                    (bool ok,) = terms.refundTo.call{value: refund, gas: REFUND_GAS}("");
                    if (ok) {
                        balance -= refund;
                    } else {
                        emit RefundFailed(userOpHash, terms.refundTo, address(0), refund);
                        refund = 0;
                    }
                }
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

    function _settleToken(bytes32 userOpHash, Terms memory terms, uint256 keep, uint256 actualGasCost, uint256 balance)
        internal
    {
        IERC20 token = IERC20(terms.feeToken);
        uint256 refund = 0;
        if (terms.refundTo != address(0)) {
            if (balance == 0) emit FeeNotReceived(userOpHash, terms.feeToken, terms.fee);
            if (terms.fee > keep) {
                refund = terms.fee - keep;
                if (refund > balance) refund = balance;
                // External self-call so a misbehaving token cannot revert postOp.
                if (refund > 0) {
                    try this.refundToken(token, terms.refundTo, refund) {}
                    catch {
                        emit RefundFailed(userOpHash, terms.refundTo, terms.feeToken, refund);
                        refund = 0;
                    }
                }
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
