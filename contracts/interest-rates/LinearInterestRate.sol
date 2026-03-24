// SPDX-License-Identifier: ISC
pragma solidity ^0.8.19;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IRateCalculatorV2} from "../interfaces/IRateCalculatorV2.sol";

/// @title Linear interest rate curve with constant vertex rate
/// @notice Calculates rate purely from utilization
contract LinearInterestRate is IRateCalculatorV2 {
    using Strings for uint256;

    /// @notice The name suffix for the interest rate calculator
    string public suffix;

    // Utilization Settings
    /// @notice The utilization at which the slope changes (kink / vertex)
    uint256 public immutable VERTEX_UTILIZATION;
    /// @notice precision of utilization calculations
    uint256 public constant UTIL_PREC = 1e5; // 5 decimals

    // Interest Rate Settings (all rates are per second), 365.24 days per year
    /// @notice The interest rate (per second) when utilization is 0%
    uint256 public immutable ZERO_UTIL_RATE; // 18 decimals
    /// @notice The interest rate (per second) at vertex utilization
    uint256 public immutable VERTEX_RATE; // 18 decimals
    /// @notice The interest rate (per second) when utilization is 100%
    uint256 public immutable FULL_UTIL_RATE; // 18 decimals

    /// @param _suffix The suffix of the contract name
    /// @param _vertexUtilization The utilization at which the slope changes (kink)
    /// @param _zeroUtilizationRate The interest rate (per second) when utilization is 0%
    /// @param _vertexRate The interest rate (per second) at vertex utilization
    /// @param _fullUtilizationRate The interest rate (per second) when utilization is 100%
    constructor(
        string memory _suffix,
        uint256 _vertexUtilization,
        uint256 _zeroUtilizationRate,
        uint256 _vertexRate,
        uint256 _fullUtilizationRate
    ) {
        require(_vertexUtilization > 0 && _vertexUtilization < UTIL_PREC, "bad vertex util");
        require(
            _zeroUtilizationRate <= _vertexRate && _vertexRate <= _fullUtilizationRate,
            "rates not monotonic"
        );

        suffix = _suffix;
        VERTEX_UTILIZATION = _vertexUtilization;
        ZERO_UTIL_RATE = _zeroUtilizationRate;
        VERTEX_RATE = _vertexRate;
        FULL_UTIL_RATE = _fullUtilizationRate;
    }

    function name() external view returns (string memory) {
        return string(abi.encodePacked("Linear Rate ", suffix));
    }

    function version()
        external
        pure
        returns (uint256 _major, uint256 _minor, uint256 _patch)
    {
        _major = 1;
        _minor = 0;
        _patch = 0;
    }

    /// @notice Utilization-only linear curve with constant vertex rate
    /// @dev Keeps IRateCalculatorV2 signature; time and old full rate are ignored.
    function getNewRate(
        uint256,
        uint256 _utilization,
        uint64
    ) external view returns (uint64 _newRatePerSec, uint64 _newFullUtilizationInterest) {
        if (_utilization > UTIL_PREC) _utilization = UTIL_PREC;

        uint256 rate;
        if (_utilization < VERTEX_UTILIZATION) {
            // linear from ZERO_UTIL_RATE -> VERTEX_RATE
            rate =
                ZERO_UTIL_RATE +
                (_utilization * (VERTEX_RATE - ZERO_UTIL_RATE)) /
                VERTEX_UTILIZATION;
        } else {
            // linear from VERTEX_RATE -> FULL_UTIL_RATE
            rate =
                VERTEX_RATE +
                ((_utilization - VERTEX_UTILIZATION) *
                    (FULL_UTIL_RATE - VERTEX_RATE)) /
                (UTIL_PREC - VERTEX_UTILIZATION);
        }

        _newRatePerSec = _toUint64(rate);
        _newFullUtilizationInterest = uint64(FULL_UTIL_RATE);
    }

    function _toUint64(uint256 value) internal pure returns (uint64) {
        require(value <= type(uint64).max, "uint64 overflow");
        return uint64(value);
    }
}
