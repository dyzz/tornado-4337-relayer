// SPDX-License-Identifier: MIT
// Minimal OpenZeppelin 3.4-compatible SafeERC20 (solc 0.7), vendored so the
// upstream tornado-core ERC20Tornado compiles unchanged.
pragma solidity ^0.7.0;

import "./IERC20.sol";

library SafeERC20 {
  function safeTransfer(IERC20 token, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
  }

  function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
  }

  function _callOptionalReturn(IERC20 token, bytes memory data) private {
    uint256 size;
    address target = address(token);
    // solhint-disable-next-line no-inline-assembly
    assembly { size := extcodesize(target) }
    require(size > 0, "SafeERC20: call to non-contract");
    (bool success, bytes memory returndata) = target.call(data);
    require(success, "SafeERC20: low-level call failed");
    if (returndata.length > 0) {
      require(abi.decode(returndata, (bool)), "SafeERC20: ERC20 operation did not succeed");
    }
  }
}
