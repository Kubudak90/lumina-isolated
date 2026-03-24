// SPDX-License-Identifier: ISC
pragma solidity ^0.8.19;

import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';

contract LightlendWhitelist is Ownable2Step {
    /// @notice Lightlend Deployer Whitelist mapping.
    mapping(address => bool) public lightlendDeployerWhitelist;

    constructor() Ownable2Step() {}

    /// @notice The ```SetLightlendDeployerWhitelist``` event fires whenever a status is set for a given address.
    /// @param _address address being set.
    /// @param _bool approval being set.
    event SetLightlendDeployerWhitelist(address indexed _address, bool _bool);

    /// @notice The ```setLightlendDeployerWhitelist``` function sets a given address to true/false for use as a custom deployer.
    /// @param _addresses addresses to set status for.
    /// @param _bool status of approval.
    function setLightlendDeployerWhitelist(
        address[] calldata _addresses,
        bool _bool
    ) external onlyOwner {
        for (uint256 i = 0; i < _addresses.length; i++) {
            lightlendDeployerWhitelist[_addresses[i]] = _bool;
            emit SetLightlendDeployerWhitelist(_addresses[i], _bool);
        }
    }
}
