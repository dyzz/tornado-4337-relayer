// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface of a Tornado Cash ETH instance (ETHTornado).
interface ITornadoInstance {
    function denomination() external view returns (uint256);
    function levels() external view returns (uint32);
    function verifier() external view returns (address);
    function getLastRoot() external view returns (bytes32);
    function isKnownRoot(bytes32 root) external view returns (bool);
    function isSpent(bytes32 nullifierHash) external view returns (bool);
    function nextIndex() external view returns (uint32);

    function deposit(bytes32 commitment) external payable;

    function withdraw(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee,
        uint256 refund
    ) external payable;
}
