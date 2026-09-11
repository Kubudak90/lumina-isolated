// SPDX-License-Identifier: ISC
pragma solidity ^0.8.19;

/// @title LightlendPairValidation
/// @notice Shared constructor/setter checks so pair config cannot skip bounds that setters enforce.
library LightlendPairValidation {
    uint256 internal constant LTV_PRECISION = 1e5;
    uint256 internal constant LIQ_PRECISION = 1e5;
    uint256 internal constant DEVIATION_PRECISION = 1e5;
    uint256 internal constant MAX_PROTOCOL_FEE = 5e4; // 50% of 1e5
    uint256 internal constant MAX_LIQUIDATION_FEE = 50_000; // 50% of 1e5
    uint256 internal constant MAX_SEED_AMOUNT = 1e18;

    error ZeroAddress();
    error AssetEqualsCollateral();
    error InvalidOracleDeviation();
    error InvalidUtilizationRate();
    error InvalidLTV();
    error InvalidLiquidationFee();
    error InvalidProtocolFee();
    error InvalidSeedAmount();

    function validateNonZero(address _addr) internal pure {
        if (_addr == address(0)) revert ZeroAddress();
    }

    function validatePairTokens(address _asset, address _collateral) internal pure {
        if (_asset == address(0) || _collateral == address(0)) revert ZeroAddress();
        if (_asset == _collateral) revert AssetEqualsCollateral();
    }

    function validateOracle(address _oracle, uint256 _maxOracleDeviation) internal pure {
        if (_oracle == address(0)) revert ZeroAddress();
        if (_maxOracleDeviation == 0 || _maxOracleDeviation >= DEVIATION_PRECISION) {
            revert InvalidOracleDeviation();
        }
    }

    function validateRateParams(address _rateContract, uint256 _fullUtilizationRate) internal pure {
        if (_rateContract == address(0)) revert ZeroAddress();
        if (_fullUtilizationRate == 0) revert InvalidUtilizationRate();
    }

    function validateLTV(uint256 _maxLTV) internal pure {
        if (_maxLTV == 0 || _maxLTV > LTV_PRECISION) revert InvalidLTV();
    }

    function validateLiquidationFees(
        uint256 _cleanLiquidationFee,
        uint256 _dirtyLiquidationFee,
        uint256 _protocolLiquidationFee
    ) internal pure {
        if (_cleanLiquidationFee == 0 || _dirtyLiquidationFee == 0) revert InvalidLiquidationFee();
        if (
            _cleanLiquidationFee > MAX_LIQUIDATION_FEE || _dirtyLiquidationFee > MAX_LIQUIDATION_FEE
        ) {
            revert InvalidLiquidationFee();
        }
        if (_protocolLiquidationFee >= LIQ_PRECISION) revert InvalidLiquidationFee();
        if (
            _cleanLiquidationFee + _protocolLiquidationFee >= LIQ_PRECISION ||
            _dirtyLiquidationFee + _protocolLiquidationFee >= LIQ_PRECISION
        ) {
            revert InvalidLiquidationFee();
        }
    }

    function validateProtocolFee(uint256 _protocolFee) internal pure {
        if (_protocolFee > MAX_PROTOCOL_FEE) revert InvalidProtocolFee();
    }

    function validateSeedAmount(uint256 _amount) internal pure {
        if (_amount == 0 || _amount > MAX_SEED_AMOUNT) revert InvalidSeedAmount();
    }
}
