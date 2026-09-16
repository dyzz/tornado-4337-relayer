// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * A paymaster from an imaginary earlier release: the same getters the relayer reads at start-up, but a
 * sponsorship-terms layout one field shorter (297 bytes, the size this project used before the terms
 * gained the bound sender implementation).
 *
 * It exists so the start-up preflight can be tested against exactly the situation that has already
 * occurred once — a contract deployed by an older version of this software — without keeping the old
 * contract around. Staking and funding such a paymaster is pure loss: it would reject every sponsorship
 * the current code signs.
 */
contract LegacyLayoutPaymaster {
    uint256 public constant PAYMASTER_AND_DATA_LENGTH = 297;
    address public immutable entryPoint;
    address public immutable verifyingSigner;
    address public router;
    address public owner;

    constructor(address entryPoint_, address verifyingSigner_) {
        entryPoint = entryPoint_;
        verifyingSigner = verifyingSigner_;
        owner = msg.sender;
    }

    function getDeposit() external pure returns (uint256) {
        return 0;
    }
}
