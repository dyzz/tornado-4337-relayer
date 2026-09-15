// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {ITornadoRouter} from "./interfaces/ITornadoRouter.sol";
import {TornadoRelayerPaymasterCore} from "./TornadoRelayerPaymasterCore.sol";

/// @title TornadoRelayerPaymaster7702
/// @notice EIP-7702 delegate for existing Tornado relayers: the relayer's *worker* EOA — the key
/// `tornado-relayer` already uses, already registered as a worker of the relayer's master in the
/// DAO's `RelayerRegistry` — delegates its code to this contract and becomes the paymaster.
/// Nothing changes in the registry: the router still sees the registered worker as `msg.sender`,
/// the fee still goes to the master, the master's stake is still burned.
///
/// One instance is deployed per chain and shared by every relayer; the EOA's own storage holds
/// any per-relayer overrides. With no overrides:
///   owner            = the EOA itself (admin functions are self-calls, i.e. transactions the
///                      relayer key sends to its own address)
///   verifyingSigner  = the EOA itself (the same key signs the sponsorships)
///   router / gas params = the per-chain defaults baked in at deployment
contract TornadoRelayerPaymaster7702 is TornadoRelayerPaymasterCore {
    uint256 private constant UNSET = type(uint256).max;

    ITornadoRouter public immutable defaultRouter;
    uint256 public immutable defaultGasMarginBps;
    uint256 public immutable defaultPostOpGasOverhead;

    // Per-delegator overrides (live in the EOA's storage; zero / UNSET = default).
    address private _verifyingSigner;
    uint256 private _gasMarginBps;
    uint256 private _postOpGasOverhead;
    bool private _paramsSet;
    // Router override: address(1) means "explicitly none" (call pools directly).
    ITornadoRouter private _router;

    constructor(IEntryPoint _entryPoint, ITornadoRouter _defaultRouter, uint256 _gasMarginBps_, uint256 _postOpGasOverhead_)
        TornadoRelayerPaymasterCore(_entryPoint)
    {
        defaultRouter = _defaultRouter;
        defaultGasMarginBps = _gasMarginBps_;
        defaultPostOpGasOverhead = _postOpGasOverhead_;
    }

    function owner() public view override returns (address) {
        return address(this);
    }

    function verifyingSigner() public view override returns (address) {
        return _verifyingSigner == address(0) ? address(this) : _verifyingSigner;
    }

    function gasMarginBps() public view override returns (uint256) {
        return _paramsSet ? _gasMarginBps : defaultGasMarginBps;
    }

    function postOpGasOverhead() public view override returns (uint256) {
        return _paramsSet ? _postOpGasOverhead : defaultPostOpGasOverhead;
    }

    function router() public view override returns (ITornadoRouter) {
        if (address(_router) == address(0)) return defaultRouter;
        if (address(_router) == address(1)) return ITornadoRouter(address(0));
        return _router;
    }

    /// @notice Sign sponsorships with a key other than the EOA itself (address(0) resets to the EOA).
    function setVerifyingSigner(address verifyingSigner_) external onlyOwner {
        _verifyingSigner = verifyingSigner_;
        emit VerifyingSignerSet(verifyingSigner());
    }

    function setGasParams(uint256 gasMarginBps_, uint256 postOpGasOverhead_) external onlyOwner {
        _gasMarginBps = gasMarginBps_;
        _postOpGasOverhead = postOpGasOverhead_;
        _paramsSet = true;
        emit GasMarginSet(gasMarginBps_);
        emit PostOpGasOverheadSet(postOpGasOverhead_);
    }

    /// @notice Override the chain default router; address(1) = call pools directly; address(0) = default.
    function setRouter(ITornadoRouter router_) external onlyOwner {
        _router = router_;
        emit RouterSet(address(router()));
    }
}
