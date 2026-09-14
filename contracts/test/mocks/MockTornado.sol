// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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

    function deposit(bytes32 commitment) external payable {
        require(msg.value == denomination, "Please send `mixDenomination` ETH along with transaction");
        emit Deposit(commitment, 0, block.timestamp);
    }

    event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp);

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

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Tornado ERC-20 instance stand-in (ERC20Tornado payout rules, no ZK).
contract MockTornadoERC20 {
    IERC20 public immutable token;
    uint256 public immutable denomination;
    mapping(bytes32 => bool) public nullifierHashes;

    event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee);

    constructor(IERC20 _token, uint256 _denomination) {
        token = _token;
        denomination = _denomination;
    }

    function isSpent(bytes32 nullifierHash) external view returns (bool) {
        return nullifierHashes[nullifierHash];
    }

    event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp);

    /// @dev ERC20Tornado pulls the denomination from msg.sender (the router when deposited through it).
    function deposit(bytes32 commitment) external payable {
        require(msg.value == 0, "ETH value is supposed to be 0 for ERC20 instance");
        require(token.transferFrom(msg.sender, address(this), denomination), "transferFrom failed");
        emit Deposit(commitment, 0, block.timestamp);
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
        require(fee <= denomination, "Fee exceeds transfer value");
        require(!nullifierHashes[nullifierHash], "The note has been already spent");
        require(msg.value == refund, "Incorrect refund amount received by the contract");
        nullifierHashes[nullifierHash] = true;

        require(token.transfer(recipient, denomination - fee), "transfer failed");
        if (fee > 0) require(token.transfer(relayer, fee), "fee transfer failed");
        if (refund > 0) {
            (bool ok,) = recipient.call{value: refund}("");
            require(ok, "refund failed");
        }
        emit Withdrawal(recipient, nullifierHash, relayer, fee);
    }
}
