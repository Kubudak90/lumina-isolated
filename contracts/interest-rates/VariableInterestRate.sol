// SPDX-License-Identifier: ISC
pragma solidity ^0.8.19;

import {Strings} from '@openzeppelin/contracts/utils/Strings.sol';
import {IRateCalculatorV2} from '../interfaces/IRateCalculatorV2.sol';

/// @title A formula for calculating interest rates as a function of utilization and time
/// @notice A Contract for calculating interest rates as a function of utilization and time
contract VariableInterestRate is IRateCalculatorV2 {
    using Strings for uint256;

    /// @notice The name suffix for the interest rate calculator
    string public suffix;

    // Utilization Settings
    /// @notice The minimum utilization wherein no adjustment to full utilization and vertex rates occurs
    uint256 public immutable MIN_TARGET_UTIL;
    /// @notice The maximum utilization wherein no adjustment to full utilization and vertex rates occurs
    uint256 public immutable MAX_TARGET_UTIL;
    /// @notice The utilization at which the slope increases
    uint256 public immutable VERTEX_UTILIZATION;
    /// @notice precision of utilization calculations
    uint256 public constant UTIL_PREC = 1e5; // 5 decimals

    // Interest Rate Settings (all rates are per second), 365.24 days per year
    /// @notice The minimum interest rate (per second) when utilization is 100%
    uint256 public immutable MIN_FULL_UTIL_RATE; // 18 decimals
    /// @notice The maximum interest rate (per second) when utilization is 100%
    uint256 public immutable MAX_FULL_UTIL_RATE; // 18 decimals
    /// @notice The interest rate (per second) when utilization is 0%
    uint256 public immutable ZERO_UTIL_RATE; // 18 decimals
    /// @notice The interest rate half life in seconds, determines rate of adjustments to rate curve
    uint256 public immutable RATE_HALF_LIFE; // 1 decimals
    /// @notice The percent of the delta between max and min
    uint256 public immutable VERTEX_RATE_PERCENT; // 18 decimals
    /// @notice The precision of interest rate calculations
    uint256 public constant RATE_PREC = 1e18; // 18 decimals

    /// @notice The ```constructor``` function
    /// @param _suffix The suffix of the contract name
    /// @param _vertexUtilization The utilization at which the slope increases
    /// @param _vertexRatePercentOfDelta The percent of the delta between max and min, defines vertex rate
    /// @param _minUtil The minimum utilization wherein no adjustment to full utilization and vertex rates occurs
    /// @param _maxUtil The maximum utilization wherein no adjustment to full utilization and vertex rates occurs
    /// @param _zeroUtilizationRate The interest rate (per second) when utilization is 0%
    /// @param _minFullUtilizationRate The minimum interest rate at 100% utilization
    /// @param _maxFullUtilizationRate The maximum interest rate at 100% utilization
    /// @param _rateHalfLife The half life parameter for interest rate adjustments
    constructor(
        string memory _suffix,
        uint256 _vertexUtilization,
        uint256 _vertexRatePercentOfDelta,
        uint256 _minUtil,
        uint256 _maxUtil,
        uint256 _zeroUtilizationRate,
        uint256 _minFullUtilizationRate,
        uint256 _maxFullUtilizationRate,
        uint256 _rateHalfLife
    ) {
        // Validate constructor parameters (ISO-04). Together with getNewRate() clamping utilization to
        // UTIL_PREC and getFullUtilizationInterest() clamping in uint256 before its uint64 cast, these
        // keep getNewRate() free of division by zero, underflow and overflow for every utilization,
        // every _deltaTime < 2^64 and every uint64 _fullUtilizationInterest, and make every uint64
        // cast exact, so the pair's _addInterest() (run by pause(), repay, liquidate, ...) cannot be
        // bricked by the rate:
        //  - maxUtil < UTIL_PREC: getFullUtilizationInterest divides by (UTIL_PREC - MAX_TARGET_UTIL).
        //  - 0 < vertexUtilization < UTIL_PREC: getNewRate divides by VERTEX_UTILIZATION and by
        //    (UTIL_PREC - VERTEX_UTILIZATION); vertex == 100% divided by zero at full utilization.
        //  - vertexRatePercentOfDelta <= RATE_PREC: keeps the vertex rate <= the full-utilization rate,
        //    otherwise (_newFullUtilizationInterest - _vertexInterest) underflows at/above the vertex,
        //    and keeps every per-second rate <= the full-utilization rate (so its uint64 cast is exact).
        //  - zero <= minFull <= maxFull <= type(uint64).max: the clamped full rate fits uint64 and is
        //    never below ZERO_UTIL_RATE, so (_new - ZERO_UTIL_RATE) is safe.
        //  - 0 < rateHalfLife <= type(uint64).max: non-zero divisor; bounds
        //    _fullUtilizationInterest * (RATE_HALF_LIFE * 1e36 + 1e36 * _deltaTime) below 2^256.
        // The old `_zeroUtilizationRate <= _vertexRatePercentOfDelta` check compared a per-second rate
        // with a 1e18 percentage, so it guarded nothing and is removed.
        require(_minUtil <= _maxUtil, "min > max target util");
        require(_maxUtil < UTIL_PREC, "target util >= 100%");
        require(_vertexUtilization > 0, "vertex util is 0");
        require(_vertexUtilization < UTIL_PREC, "vertex util >= 100%");
        require(_vertexRatePercentOfDelta <= RATE_PREC, "vertex rate percent > 100%");
        require(_minFullUtilizationRate <= _maxFullUtilizationRate, "min > max full util rate");
        require(_maxFullUtilizationRate <= type(uint64).max, "max full util rate > uint64");
        require(_rateHalfLife > 0, "rate half life is 0");
        require(_rateHalfLife <= type(uint64).max, "rate half life > uint64");
        require(_zeroUtilizationRate <= _minFullUtilizationRate, "zero rate > min full util");

        suffix = _suffix;
        MIN_TARGET_UTIL = _minUtil;
        MAX_TARGET_UTIL = _maxUtil;
        VERTEX_UTILIZATION = _vertexUtilization;
        ZERO_UTIL_RATE = _zeroUtilizationRate;
        MIN_FULL_UTIL_RATE = _minFullUtilizationRate;
        MAX_FULL_UTIL_RATE = _maxFullUtilizationRate;
        RATE_HALF_LIFE = _rateHalfLife;
        VERTEX_RATE_PERCENT = _vertexRatePercentOfDelta;
    }

    /// @notice The ```name``` function returns the name of the rate contract
    /// @return memory name of contract
    function name() external view returns (string memory) {
        return string(abi.encodePacked('Variable Rate V2 ', suffix));
    }

    /// @notice The ```version``` function returns the semantic version of the rate contract
    /// @dev Follows semantic versioning
    /// @return _major Major version
    /// @return _minor Minor version
    /// @return _patch Patch version
    function version() external pure returns (uint256 _major, uint256 _minor, uint256 _patch) {
        _major = 2;
        _minor = 0;
        _patch = 0;
    }

    /// @notice The ```getFullUtilizationInterest``` function calculate the new maximum interest rate, i.e. rate when utilization is 100%
    /// @dev Given in interest per second
    /// @param _deltaTime The elapsed time since last update given in seconds
    /// @param _utilization The utilization %, given with 5 decimals of precision
    /// @param _fullUtilizationInterest The interest value when utilization is 100%, given with 18 decimals of precision
    /// @return _newFullUtilizationInterest The new maximum interest rate
    function getFullUtilizationInterest(
        uint256 _deltaTime,
        uint256 _utilization,
        uint64 _fullUtilizationInterest
    ) internal view returns (uint64 _newFullUtilizationInterest) {
        // ISO-04: computed and clamped in uint256, cast to uint64 only after the clamp. Casting first
        // wrapped values >= 2^64 (e.g. growth from a high full-utilization rate) to a small number that
        // the clamp then raised to MIN_FULL_UTIL_RATE instead of MAX_FULL_UTIL_RATE.
        uint256 _newRate;
        if (_utilization < MIN_TARGET_UTIL) {
            // 18 decimals
            uint256 _deltaUtilization = ((MIN_TARGET_UTIL - _utilization) * 1e18) / MIN_TARGET_UTIL;
            // 36 decimals
            uint256 _decayGrowth = (RATE_HALF_LIFE * 1e36) +
                (_deltaUtilization * _deltaUtilization * _deltaTime);
            // 18 decimals
            _newRate = (_fullUtilizationInterest * (RATE_HALF_LIFE * 1e36)) / _decayGrowth;
        } else if (_utilization > MAX_TARGET_UTIL) {
            // 18 decimals
            uint256 _deltaUtilization = ((_utilization - MAX_TARGET_UTIL) * 1e18) /
                (UTIL_PREC - MAX_TARGET_UTIL);
            // 36 decimals
            uint256 _decayGrowth = (RATE_HALF_LIFE * 1e36) +
                (_deltaUtilization * _deltaUtilization * _deltaTime);
            // 18 decimals
            _newRate = (_fullUtilizationInterest * _decayGrowth) / (RATE_HALF_LIFE * 1e36);
        } else {
            _newRate = _fullUtilizationInterest;
        }
        if (_newRate > MAX_FULL_UTIL_RATE) {
            _newRate = MAX_FULL_UTIL_RATE;
        } else if (_newRate < MIN_FULL_UTIL_RATE) {
            _newRate = MIN_FULL_UTIL_RATE;
        }
        // Exact: _newRate <= MAX_FULL_UTIL_RATE <= type(uint64).max (constructor)
        _newFullUtilizationInterest = uint64(_newRate);
    }

    /// @notice The ```getNewRate``` function calculates interest rates using two linear functions f(utilization)
    /// @param _deltaTime The elapsed time since last update, given in seconds
    /// @param _utilization The utilization %, given with 5 decimals of precision
    /// @param _oldFullUtilizationInterest The interest value when utilization is 100%, given with 18 decimals of precision
    /// @return _newRatePerSec The new interest rate, 18 decimals of precision
    /// @return _newFullUtilizationInterest The new max interest rate, 18 decimals of precision
    function getNewRate(
        uint256 _deltaTime,
        uint256 _utilization,
        uint64 _oldFullUtilizationInterest
    ) external view returns (uint64 _newRatePerSec, uint64 _newFullUtilizationInterest) {
        // ISO-04 defence in depth: the pair keeps utilization <= 100%, but an over-100% value must never
        // reach the squared delta in getFullUtilizationInterest or the uint64 casts below.
        if (_utilization > UTIL_PREC) _utilization = UTIL_PREC;

        _newFullUtilizationInterest = getFullUtilizationInterest(
            _deltaTime,
            _utilization,
            _oldFullUtilizationInterest
        );

        // _vertexInterest is calculated as the percentage of the delta between min and max interest
        uint256 _vertexInterest = (((_newFullUtilizationInterest - ZERO_UTIL_RATE) *
            VERTEX_RATE_PERCENT) / RATE_PREC) + ZERO_UTIL_RATE;
        if (_utilization < VERTEX_UTILIZATION) {
            // For readability, the following formula is equivalent to:
            // uint256 _slope = ((_vertexInterest - ZERO_UTIL_RATE) * UTIL_PREC) / VERTEX_UTILIZATION;
            // _newRatePerSec = uint64(ZERO_UTIL_RATE + ((_utilization * _slope) / UTIL_PREC));

            // 18 decimals
            _newRatePerSec = uint64(
                ZERO_UTIL_RATE +
                    (_utilization * (_vertexInterest - ZERO_UTIL_RATE)) /
                    VERTEX_UTILIZATION
            );
        } else {
            // For readability, the following formula is equivalent to:
            // uint256 _slope = (((_newFullUtilizationInterest - _vertexInterest) * UTIL_PREC) / (UTIL_PREC - VERTEX_UTILIZATION));
            // _newRatePerSec = uint64(_vertexInterest + (((_utilization - VERTEX_UTILIZATION) * _slope) / UTIL_PREC));

            // 18 decimals
            _newRatePerSec = uint64(
                _vertexInterest +
                    ((_utilization - VERTEX_UTILIZATION) *
                        (_newFullUtilizationInterest - _vertexInterest)) /
                    (UTIL_PREC - VERTEX_UTILIZATION)
            );
        }
    }
}
