// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {ITornadoRouter} from "./interfaces/ITornadoRouter.sol";
import {TornadoRelayerPaymasterCore} from "./TornadoRelayerPaymasterCore.sol";

/// @title TornadoRelayerPaymaster
/// @notice Standalone deployment of the thin-relayer paymaster (see the core for the mechanics).
/// Suited to a *new* relayer that registers the contract as its own master, or to an operator who
/// prefers a separate contract as the worker of their existing relayer. Existing relayers can
/// instead delegate their worker EOA to `TornadoRelayerPaymaster7702`.
contract TornadoRelayerPaymaster is TornadoRelayerPaymasterCore {
    address private _owner;
    address private _verifyingSigner;
    uint256 private _gasMarginBps;
    uint256 private _postOpGasOverhead;
    ITornadoRouter private _router;

    constructor(IEntryPoint _entryPoint, address verifyingSigner_, uint256 gasMarginBps_, uint256 postOpGasOverhead_)
        TornadoRelayerPaymasterCore(_entryPoint)
    {
        if (verifyingSigner_ == address(0)) revert ZeroAddress();
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _verifyingSigner = verifyingSigner_;
        _gasMarginBps = gasMarginBps_;
        _postOpGasOverhead = postOpGasOverhead_;
        emit VerifyingSignerSet(verifyingSigner_);
        emit GasMarginSet(gasMarginBps_);
        emit PostOpGasOverheadSet(postOpGasOverhead_);
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function owner() public view override returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    function verifyingSigner() public view override returns (address) {
        return _verifyingSigner;
    }

    function gasMarginBps() public view override returns (uint256) {
        return _gasMarginBps;
    }

    function postOpGasOverhead() public view override returns (uint256) {
        return _postOpGasOverhead;
    }

    function router() public view override returns (ITornadoRouter) {
        return _router;
    }

    function setVerifyingSigner(address verifyingSigner_) external onlyOwner {
        if (verifyingSigner_ == address(0)) revert ZeroAddress();
        _verifyingSigner = verifyingSigner_;
        emit VerifyingSignerSet(verifyingSigner_);
    }

    function setGasMarginBps(uint256 gasMarginBps_) external onlyOwner {
        _gasMarginBps = gasMarginBps_;
        emit GasMarginSet(gasMarginBps_);
    }

    function setPostOpGasOverhead(uint256 postOpGasOverhead_) external onlyOwner {
        _postOpGasOverhead = postOpGasOverhead_;
        emit PostOpGasOverheadSet(postOpGasOverhead_);
    }

    function setRouter(ITornadoRouter router_) external onlyOwner {
        _router = router_;
        emit RouterSet(address(router_));
    }
}
