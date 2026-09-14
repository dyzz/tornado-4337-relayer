// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITornadoInstance} from "./ITornadoInstance.sol";

/// @notice Tornado Cash governance proxy (`TornadoRouter`). Withdrawals sent through it call
/// `RelayerRegistry.burn(msg.sender, relayer, pool)`, which deducts the pool's TORN fee from
/// the relayer's stake and credits it to TORN stakers — the DAO's relayer economics.
interface ITornadoRouter {
    function withdraw(
        ITornadoInstance tornado,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee,
        uint256 refund
    ) external payable;

    function relayerRegistry() external view returns (address);
    function instanceRegistry() external view returns (address);
}

/// @notice The subset of `RelayerRegistry` the paymaster and its operator use.
interface IRelayerRegistry {
    /// @dev `msg.sender` must own the ENS name; moves `stake` TORN (approved to the registry) to staking.
    function register(string calldata ensName, uint256 stake, address[] calldata workersToRegister) external;
    /// @dev `msg.sender` must be a worker (or the master) of `relayer`.
    function registerWorker(address relayer, address worker) external;
    function unregisterWorker(address worker) external;
    function stakeToRelayer(address relayer, uint256 stake) external;

    /// @dev worker -> master. A master maps to itself; unregistered addresses map to 0.
    function workers(address worker) external view returns (address);
    function getRelayerBalance(address relayer) external view returns (uint256);
    function getRelayerEnsHash(address relayer) external view returns (bytes32);
    function isRelayer(address toResolve) external view returns (bool);
    function minStakeAmount() external view returns (uint256);
    function tornadoRouter() external view returns (address);
    function torn() external view returns (address);
}
