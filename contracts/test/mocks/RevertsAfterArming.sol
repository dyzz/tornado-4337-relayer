// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * A tail-call target that succeeds when simulated and reverts when it is actually executed.
 *
 * `arm()` is what makes the difference: it is sent as a plain transaction *after* the relayer has
 * signed the sponsorship, so the pre-signing simulation sees the passing version and the included
 * operation sees the failing one. That models the residual risk honestly — chain state moves between
 * signature and inclusion, and no amount of simulation removes it — instead of relying on a target that
 * would already have been refused at signing time.
 */
contract RevertsAfterArming {
    bool public armed;

    function arm() external {
        armed = true;
    }

    /// Accepts the note's value; reverts once armed.
    function receiveFunds() external payable {
        require(!armed, "armed");
    }
}
