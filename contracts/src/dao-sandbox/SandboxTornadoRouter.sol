// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITornadoInstance} from "../interfaces/ITornadoInstance.sol";
import {SandboxInstanceRegistry} from "./SandboxInstanceRegistry.sol";
import {SandboxRelayerRegistry} from "./SandboxRelayerRegistry.sol";

/// @notice `TornadoRouter` (mainnet 0xd90e…F31b) for the sandbox: same ABI and behaviour —
/// `withdraw` calls `relayerRegistry.burn(msg.sender, relayer, pool)` before the pool.
contract SandboxTornadoRouter {
    using SafeERC20 for IERC20;

    event EncryptedNote(address indexed sender, bytes encryptedNote);

    address public immutable governance;
    SandboxInstanceRegistry public immutable instanceRegistry;
    SandboxRelayerRegistry public immutable relayerRegistry;

    modifier onlyGovernance() {
        require(msg.sender == governance, "Not authorized");
        _;
    }

    modifier onlyInstanceRegistry() {
        require(msg.sender == address(instanceRegistry), "Not authorized");
        _;
    }

    constructor(address _governance, SandboxInstanceRegistry _instanceRegistry, SandboxRelayerRegistry _relayerRegistry) {
        governance = _governance;
        instanceRegistry = _instanceRegistry;
        relayerRegistry = _relayerRegistry;
    }

    function deposit(ITornadoInstance _tornado, bytes32 _commitment, bytes calldata _encryptedNote)
        public
        payable
        virtual
    {
        (bool isERC20, IERC20 token, SandboxInstanceRegistry.InstanceState state,,) = instanceRegistry.instances(_tornado);
        require(state != SandboxInstanceRegistry.InstanceState.DISABLED, "The instance is not supported");

        if (isERC20) {
            token.safeTransferFrom(msg.sender, address(this), _tornado.denomination());
        }
        _tornado.deposit{value: msg.value}(_commitment);
        emit EncryptedNote(msg.sender, _encryptedNote);
    }

    function withdraw(
        ITornadoInstance _tornado,
        bytes calldata _proof,
        bytes32 _root,
        bytes32 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _fee,
        uint256 _refund
    ) public payable virtual {
        (,, SandboxInstanceRegistry.InstanceState state,,) = instanceRegistry.instances(_tornado);
        require(state != SandboxInstanceRegistry.InstanceState.DISABLED, "The instance is not supported");

        relayerRegistry.burn(msg.sender, _relayer, _tornado);
        _tornado.withdraw{value: msg.value}(_proof, _root, _nullifierHash, _recipient, _relayer, _fee, _refund);
    }

    /// @dev Sets `amount` allowance of `_spender` over the router's tokens (instance registry only).
    function approveExactToken(IERC20 _token, address _spender, uint256 _amount) external onlyInstanceRegistry {
        _token.forceApprove(_spender, _amount);
    }

    /// @notice Manually backup encrypted notes.
    function backupNotes(bytes[] calldata _encryptedNotes) external virtual {
        for (uint256 i = 0; i < _encryptedNotes.length; i++) {
            emit EncryptedNote(msg.sender, _encryptedNotes[i]);
        }
    }

    /// @dev Claim junk and accidentally sent tokens.
    function rescueTokens(IERC20 _token, address payable _to, uint256 _amount) external virtual onlyGovernance {
        require(_to != address(0), "TORN: can not send to zero address");
        if (address(_token) == address(0)) {
            uint256 balance = _amount < address(this).balance ? _amount : address(this).balance;
            (bool ok,) = _to.call{value: balance}("");
            require(ok, "transfer failed");
        } else {
            uint256 totalBalance = _token.balanceOf(address(this));
            uint256 balance = _amount < totalBalance ? _amount : totalBalance;
            require(balance > 0, "TORN: trying to send 0 balance");
            _token.safeTransfer(_to, balance);
        }
    }
}
