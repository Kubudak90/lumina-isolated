// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ERC20 } from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import { ILightlendPair } from '../interfaces/ILightlendPair.sol';

import { LightlendPairDeployer } from '../LightlendPairDeployer.sol';
import { Ownable2Step } from '@openzeppelin/contracts/access/Ownable2Step.sol';
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ListingsConfigEngine
/// @author LightLend
/// @notice Contract used to seed new pairs after deployment
contract ListingsConfigEngine is Ownable2Step {
    using SafeERC20 for ERC20;

    constructor() Ownable2Step() {}

    /// @notice used to deploy new pairs
    /// @param _pairDeployer address of the LightlendPairDeployer contract
    /// @param _asset address of the asset in the new pair
    /// @param _collateral address of the collateral in the new pair
    /// @param _assetAmount amount of the asset to deposit
    /// @param _collateralAmount amount of the collateral to deposit
    /// @param _configData data used to create new pair (see LightlendPairDeployer:deploy)
    function deployPair(
        LightlendPairDeployer _pairDeployer, 
        ERC20 _asset, 
        ERC20 _collateral, 
        uint256 _assetAmount, 
        uint256 _collateralAmount, 
        bytes memory _configData
    ) external onlyOwner(){
        //deploy new pair contract
        address newPairAddress = _pairDeployer.deploy(_configData);
        ILightlendPair newPair = ILightlendPair(newPairAddress);

        //transfer seed amounts from msg.sender
        _asset.safeTransferFrom(msg.sender, address(this), _assetAmount);
        _collateral.safeTransferFrom(msg.sender, address(this), _collateralAmount);

        //approve pair to spend seed amounts
        _asset.safeIncreaseAllowance(address(newPair), _assetAmount);
        _collateral.safeIncreaseAllowance(address(newPair), _collateralAmount);

        //deposit asset and add collateral
        newPair.deposit(_assetAmount, msg.sender);
        newPair.addCollateral(_collateralAmount, msg.sender);
    }
}
