// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice EIP-137 namehash over a dotted name in memory ("relayer.eth"), as the DAO's
/// `RelayerRegistry` computes it (tornado's ENSNamehash library, ported to 0.8).
library ENSNamehash {
    function namehash(bytes memory domain) internal pure returns (bytes32) {
        return namehash(domain, 0);
    }

    function namehash(bytes memory domain, uint256 i) internal pure returns (bytes32) {
        if (domain.length <= i) return bytes32(0);
        uint256 len = labelLength(domain, i);
        return keccak256(abi.encodePacked(namehash(domain, i + len + 1), keccak(domain, i, len)));
    }

    function labelLength(bytes memory domain, uint256 i) private pure returns (uint256) {
        uint256 len;
        while (i + len != domain.length && domain[i + len] != 0x2e) {
            len++;
        }
        return len;
    }

    function keccak(bytes memory data, uint256 offset, uint256 len) private pure returns (bytes32 ret) {
        require(offset + len <= data.length, "namehash: out of bounds");
        assembly {
            ret := keccak256(add(add(data, 32), offset), len)
        }
    }
}
