// SPDX-License-Identifier: MIT
// Minimal copy of OpenZeppelin 3.4 ReentrancyGuard (solc 0.7), vendored so the
// upstream tornado-core sources compile unchanged.
pragma solidity ^0.7.0;

abstract contract ReentrancyGuard {
  uint256 private constant _NOT_ENTERED = 1;
  uint256 private constant _ENTERED = 2;
  uint256 private _status;

  constructor() {
    _status = _NOT_ENTERED;
  }

  modifier nonReentrant() {
    require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
  }
}
