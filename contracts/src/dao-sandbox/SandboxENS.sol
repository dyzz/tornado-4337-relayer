// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal ENS registry for the sandbox, with the interface and storage layout of the
/// real `ENSRegistry` (`records` at slot 0, owner first) so `RelayerRegistry.register`'s
/// `ens.owner(namehash(name)) == relayer` check works exactly as on mainnet.
/// Sandbox convenience: `admin` (the deployer) may set the owner of any node.
contract SandboxENS {
    struct Record {
        address owner;
        address resolver;
        uint64 ttl;
    }

    mapping(bytes32 => Record) private records;
    mapping(address => mapping(address => bool)) private operators;
    address public immutable admin;

    event NewOwner(bytes32 indexed node, bytes32 indexed label, address owner);
    event Transfer(bytes32 indexed node, address owner);
    event NewResolver(bytes32 indexed node, address resolver);
    event NewTTL(bytes32 indexed node, uint64 ttl);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    modifier authorised(bytes32 node) {
        address nodeOwner = records[node].owner;
        require(
            nodeOwner == msg.sender || operators[nodeOwner][msg.sender] || msg.sender == admin, "ENS: not authorised"
        );
        _;
    }

    constructor() {
        admin = msg.sender;
        records[0x0].owner = msg.sender;
    }

    function setRecord(bytes32 node, address _owner, address _resolver, uint64 _ttl) external {
        setOwner(node, _owner);
        _setResolverAndTTL(node, _resolver, _ttl);
    }

    function setSubnodeRecord(bytes32 node, bytes32 label, address _owner, address _resolver, uint64 _ttl) external {
        bytes32 subnode = setSubnodeOwner(node, label, _owner);
        _setResolverAndTTL(subnode, _resolver, _ttl);
    }

    function setOwner(bytes32 node, address _owner) public authorised(node) {
        records[node].owner = _owner;
        emit Transfer(node, _owner);
    }

    function setSubnodeOwner(bytes32 node, bytes32 label, address _owner) public authorised(node) returns (bytes32) {
        bytes32 subnode = keccak256(abi.encodePacked(node, label));
        records[subnode].owner = _owner;
        emit NewOwner(node, label, _owner);
        return subnode;
    }

    function setResolver(bytes32 node, address _resolver) public authorised(node) {
        emit NewResolver(node, _resolver);
        records[node].resolver = _resolver;
    }

    function setTTL(bytes32 node, uint64 _ttl) public authorised(node) {
        emit NewTTL(node, _ttl);
        records[node].ttl = _ttl;
    }

    function setApprovalForAll(address operator, bool approved) external {
        operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function owner(bytes32 node) public view returns (address) {
        address addr = records[node].owner;
        if (addr == address(this)) return address(0);
        return addr;
    }

    function resolver(bytes32 node) public view returns (address) {
        return records[node].resolver;
    }

    function ttl(bytes32 node) public view returns (uint64) {
        return records[node].ttl;
    }

    function recordExists(bytes32 node) public view returns (bool) {
        return records[node].owner != address(0);
    }

    function isApprovedForAll(address _owner, address operator) external view returns (bool) {
        return operators[_owner][operator];
    }

    function _setResolverAndTTL(bytes32 node, address _resolver, uint64 _ttl) internal {
        if (_resolver != records[node].resolver) {
            records[node].resolver = _resolver;
            emit NewResolver(node, _resolver);
        }
        if (_ttl != records[node].ttl) {
            records[node].ttl = _ttl;
            emit NewTTL(node, _ttl);
        }
    }
}
