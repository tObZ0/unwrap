// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Proxy fixtures for UNWRAP's proxy-detection tests.
contract Box {
    uint256 public value;

    function setValue(uint256 v) external {
        value = v;
    }
}

contract SimpleTransparentProxy {
    // EIP-1967 slots
    bytes32 private constant IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address impl) {
        assembly {
            sstore(IMPL, impl)
            sstore(ADMIN, caller())
        }
    }

    function upgradeTo(address next) external {
        address a;
        assembly { a := sload(ADMIN) }
        require(msg.sender == a, "not admin");
        assembly { sstore(IMPL, next) }
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL)
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

contract Beacon {
    address public implementation;

    constructor(address impl) {
        implementation = impl;
    }
}

contract SimpleBeaconProxy {
    bytes32 private constant BEACON = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    constructor(address beacon) {
        assembly { sstore(BEACON, beacon) }
    }

    fallback() external payable {
        address impl = Beacon(_beacon()).implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function _beacon() private view returns (address b) {
        assembly { b := sload(BEACON) }
    }
}

contract CloneFactory {
    event Cloned(address clone);

    function clone(address target) external returns (address result) {
        assembly {
            let p := mload(0x40)
            mstore(p, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(p, 0x14), shl(0x60, target))
            mstore(add(p, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            result := create(0, p, 0x37)
        }
        emit Cloned(result);
    }
}
