// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Tornado ETH instance stand-in: same withdraw ABI and payout rules, no ZK.
contract MockTornado {
    uint256 public immutable denomination;
    mapping(bytes32 => bool) public nullifierHashes;
    bool public failWithdraw;

    event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee);

    constructor(uint256 _denomination) {
        denomination = _denomination;
    }

    receive() external payable {}

    function setFailWithdraw(bool v) external {
        failWithdraw = v;
    }

    function isSpent(bytes32 nullifierHash) external view returns (bool) {
        return nullifierHashes[nullifierHash];
    }

    function withdraw(
        bytes calldata,
        bytes32,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee,
        uint256 refund
    ) external payable {
        require(!failWithdraw, "mock: forced failure");
        require(fee <= denomination, "Fee exceeds transfer value");
        require(!nullifierHashes[nullifierHash], "The note has been already spent");
        require(msg.value == 0, "Message value is supposed to be zero for ETH instance");
        require(refund == 0, "Refund value is supposed to be zero for ETH instance");
        nullifierHashes[nullifierHash] = true;

        (bool ok,) = recipient.call{value: denomination - fee}("");
        require(ok, "payment to _recipient did not go");
        if (fee > 0) {
            (ok,) = relayer.call{value: fee}("");
            require(ok, "payment to _relayer did not go");
        }
        emit Withdrawal(recipient, nullifierHash, relayer, fee);
    }
}
