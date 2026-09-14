// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITornadoInstance} from "../../src/interfaces/ITornadoInstance.sol";

/// @dev RelayerRegistry stand-in with the real burn / worker semantics (mainnet
/// 0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2) minus ENS and the TORN price oracle:
/// every burn costs a fixed `burnPerWithdraw` and any ENS name is accepted.
contract MockRelayerRegistry {
    IERC20 public immutable torn;
    address public tornadoRouter;
    uint256 public minStakeAmount;
    uint256 public burnPerWithdraw;
    uint256 public totalBurned;

    struct RelayerState {
        uint256 balance;
        bytes32 ensHash;
    }

    mapping(address => RelayerState) public relayers;
    mapping(address => address) public workers;

    event StakeBurned(address relayer, uint256 amountBurned);

    constructor(IERC20 _torn, uint256 _minStake, uint256 _burnPerWithdraw) {
        torn = _torn;
        minStakeAmount = _minStake;
        burnPerWithdraw = _burnPerWithdraw;
    }

    function setTornadoRouter(address r) external {
        tornadoRouter = r;
    }

    function register(string calldata ensName, uint256 stake, address[] calldata workersToRegister) external {
        address relayer = msg.sender;
        require(workers[relayer] == address(0), "cant register again");
        require(stake >= minStakeAmount, "!min_stake");
        require(torn.transferFrom(relayer, address(this), stake), "torn");
        relayers[relayer] = RelayerState({balance: stake, ensHash: keccak256(bytes(ensName))});
        workers[relayer] = relayer;
        for (uint256 i = 0; i < workersToRegister.length; i++) {
            _registerWorker(relayer, workersToRegister[i]);
        }
    }

    function registerWorker(address relayer, address worker) external {
        require(workers[msg.sender] == relayer, "only relayer");
        _registerWorker(relayer, worker);
    }

    function _registerWorker(address relayer, address worker) internal {
        require(workers[worker] == address(0), "can't steal an address");
        workers[worker] = relayer;
    }

    function stakeToRelayer(address relayer, uint256 stake) external {
        require(workers[relayer] == relayer, "!registered");
        require(torn.transferFrom(msg.sender, address(this), stake), "torn");
        relayers[relayer].balance += stake;
    }

    /// Verbatim logic of RelayerRegistry.burn.
    function burn(address sender, address relayer, ITornadoInstance) external {
        require(msg.sender == tornadoRouter, "only proxy");
        address masterAddress = workers[sender];
        if (masterAddress == address(0)) {
            require(workers[relayer] == address(0), "Only custom relayer");
            return;
        }
        require(masterAddress == relayer, "only relayer");
        relayers[relayer].balance -= burnPerWithdraw;
        totalBurned += burnPerWithdraw;
        emit StakeBurned(relayer, burnPerWithdraw);
    }

    function getRelayerBalance(address relayer) external view returns (uint256) {
        return relayers[workers[relayer]].balance;
    }

    function getRelayerEnsHash(address relayer) external view returns (bytes32) {
        return relayers[workers[relayer]].ensHash;
    }

    function isRelayer(address toResolve) external view returns (bool) {
        return workers[toResolve] != address(0);
    }
}

/// @dev TornadoRouter stand-in: burn on the registry, then withdraw on the pool (no instance registry).
contract MockTornadoRouter {
    MockRelayerRegistry public immutable relayerRegistry;

    constructor(MockRelayerRegistry _registry) {
        relayerRegistry = _registry;
    }

    function withdraw(
        ITornadoInstance tornado,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        address payable relayer,
        uint256 fee,
        uint256 refund
    ) external payable {
        relayerRegistry.burn(msg.sender, relayer, tornado);
        tornado.withdraw{value: msg.value}(proof, root, nullifierHash, recipient, relayer, fee, refund);
    }
}
