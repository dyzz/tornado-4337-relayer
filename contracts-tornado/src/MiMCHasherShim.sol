// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

/// @dev circomlibjs generates `MiMCSponge(xL, xR, k)`; Tornado instances call the
///      legacy two-argument `MiMCSponge(xL, xR)` (selector 0xf47d33b5). This shim
///      adapts the former to the latter with k = 0, which is what the legacy
///      generator hard-codes, so hashes match production instances bit for bit.
interface IMiMCSponge3 {
  function MiMCSponge(uint256 xL_in, uint256 xR_in, uint256 k) external pure returns (uint256 xL, uint256 xR);
}

contract MiMCHasherShim {
  IMiMCSponge3 public immutable inner;

  constructor(IMiMCSponge3 _inner) {
    inner = _inner;
  }

  function MiMCSponge(uint256 in_xL, uint256 in_xR) external view returns (uint256 xL, uint256 xR) {
    return inner.MiMCSponge(in_xL, in_xR, 0);
  }
}
