// SPDX-License-Identifier: ISC
pragma solidity ^0.8.19;

struct VaultAccount {
    uint128 amount; // Total amount, analogous to market cap
    uint128 shares; // Total shares, analogous to shares outstanding
}

/// @title VaultAccount Library
/// @author Drake Evans (Frax Finance) github.com/drakeevans, modified from work by @Boring_Crypto github.com/boring_crypto
/// @notice Provides a library for use with the VaultAccount struct, provides convenient math implementations
/// @dev Uses uint128 to save on storage
library VaultAccountingLibrary {
    uint256 private constant VIRTUAL_SHARES = 1e3;
    uint256 private constant VIRTUAL_AMOUNT = 1e3;

    /// @notice Converts a given amount of assets to shares, with optional rounding up
    function toShares(
        VaultAccount memory total,
        uint256 amount,
        bool roundUp
    ) internal pure returns (uint256 shares) {
        uint256 totalAmount = uint256(total.amount) + VIRTUAL_AMOUNT;
        uint256 totalShares = uint256(total.shares) + VIRTUAL_SHARES;

        shares = (amount * totalShares) / totalAmount;
        if (roundUp && (shares * totalAmount) / totalShares < amount) {
            shares += 1;
        }
    }

    /// @notice Converts a given number of shares to an amount of assets, with optional rounding up
    function toAmount(
        VaultAccount memory total,
        uint256 shares,
        bool roundUp
    ) internal pure returns (uint256 amount) {
        uint256 totalAmount = uint256(total.amount) + VIRTUAL_AMOUNT;
        uint256 totalShares = uint256(total.shares) + VIRTUAL_SHARES;

        amount = (shares * totalAmount) / totalShares;
        if (roundUp && (amount * totalShares) / totalAmount < shares) {
            amount += 1;
        }
    }
}
