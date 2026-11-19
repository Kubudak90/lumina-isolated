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
    /// @dev ISO-01: the liquidator must keep at least 2% of the repaid value after the protocol cut
    /// of the bonus, i.e. fee * (1 - protocolFee) >= 2%. 1e5 (LIQ_PRECISION) precision.
    uint256 internal constant MIN_LIQUIDATOR_NET_BONUS = (LIQ_PRECISION * 2) / 100; // 2% = 2_000
    /// @dev ISO-05: maxLTV * (1 + cleanLiquidationFee) must not exceed 98%. 1e5 (LTV_PRECISION) precision.
    uint256 internal constant MAX_LTV_WITH_CLEAN_FEE = (LTV_PRECISION * 98) / 100; // 98% = 98_000

    error ZeroAddress();
    error AssetEqualsCollateral();
    error InvalidOracleDeviation();
    error InvalidUtilizationRate();
    error InvalidLTV();
    error InvalidLiquidationFee();
    error InvalidProtocolFee();
    error InvalidSeedAmount();
    error InsufficientLiquidatorBonus();
    error MaxLTVTooHighForLiquidationFee();

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

    /// @notice Checks maxLTV bounds and its coupling to the clean liquidation fee (ISO-05)
    /// @dev Requires maxLTV * (1 + cleanFee) <= 98%, i.e.
    ///      maxLTV * (LIQ_PRECISION + cleanFee) <= MAX_LTV_WITH_CLEAN_FEE * LIQ_PRECISION.
    ///      A clean liquidation of a position just past maxLTV then still leaves the liquidator paying
    ///      for (almost) all of the collateral, so a borrower cannot self-liquidate at lenders' expense
    ///      without a > 2% adverse price jump. Callers must bound `_cleanLiquidationFee` first.
    /// @param _maxLTV The max LTV, LTV_PRECISION
    /// @param _cleanLiquidationFee The clean liquidation fee, LIQ_PRECISION
    function validateLTV(uint256 _maxLTV, uint256 _cleanLiquidationFee) internal pure {
        if (_maxLTV == 0 || _maxLTV > LTV_PRECISION) revert InvalidLTV();
        if (
            _maxLTV * (LIQ_PRECISION + _cleanLiquidationFee) >
            MAX_LTV_WITH_CLEAN_FEE * LIQ_PRECISION
        ) {
            revert MaxLTVTooHighForLiquidationFee();
        }
    }

    /// @notice Checks the liquidation fees (ISO-01)
    /// @dev The protocol fee is a share of the liquidation bonus only (see LightlendPairCore.liquidate),
    ///      so a liquidator repaying X keeps X * fee * (1 - protocolFee) as net bonus. Both the clean
    ///      and the dirty path must leave at least MIN_LIQUIDATOR_NET_BONUS (2%):
    ///      fee * (LIQ_PRECISION - protocolFee) >= MIN_LIQUIDATOR_NET_BONUS * LIQ_PRECISION.
    /// @param _cleanLiquidationFee Bonus (share of repaid value) when all collateral is taken, LIQ_PRECISION
    /// @param _dirtyLiquidationFee Bonus (share of repaid value) on a partial liquidation, LIQ_PRECISION
    /// @param _protocolLiquidationFee Protocol share of the bonus, LIQ_PRECISION
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
        uint256 _liquidatorShare = LIQ_PRECISION - _protocolLiquidationFee;
        if (
            _cleanLiquidationFee * _liquidatorShare < MIN_LIQUIDATOR_NET_BONUS * LIQ_PRECISION ||
            _dirtyLiquidationFee * _liquidatorShare < MIN_LIQUIDATOR_NET_BONUS * LIQ_PRECISION
        ) {
            revert InsufficientLiquidatorBonus();
        }
    }

    function validateProtocolFee(uint256 _protocolFee) internal pure {
        if (_protocolFee > MAX_PROTOCOL_FEE) revert InvalidProtocolFee();
    }

    function validateSeedAmount(uint256 _amount) internal pure {
        if (_amount == 0 || _amount > MAX_SEED_AMOUNT) revert InvalidSeedAmount();
    }
}
