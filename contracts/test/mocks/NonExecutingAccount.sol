// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";

/**
 * An account implementation that passes ERC-4337 validation and then does nothing: `execute` and
 * `executeBatch` accept the same calldata Simple7702Account does and simply return.
 *
 * This is the attack the sponsorship's `senderImplementation` binding does *not* stop by itself. Binding
 * only fixes which implementation runs the operation; it cannot tell whether that implementation honours
 * the calls the relayer validated. An EOA delegated here would ask for a sponsorship carrying a perfectly
 * valid `relayWithdraw` in its callData, get the gas paid, and never perform the withdrawal — no note
 * spent, no fee to the relayer. Only the relayer's allowlist of known account implementations keeps such
 * an operation from being signed in the first place.
 */
contract NonExecutingAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// Accepts any signature: the point is to reach execution, not to model a real account.
    function validateUserOp(PackedUserOperation calldata, bytes32, uint256 missingAccountFunds)
        external
        returns (uint256 validationData)
    {
        if (missingAccountFunds > 0) {
            (bool ok,) = msg.sender.call{value: missingAccountFunds}("");
            ok;
        }
        return 0;
    }

    function execute(address, uint256, bytes calldata) external {}

    function executeBatch(Call[] calldata) external {}

    receive() external payable {}
}
