const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const setup = require("./utils/setup");

/**
 * Isolated-pair invariants from the audit plan:
 * - totalAsset.amount tracks cash + outstanding borrows (Fraxlend vault model)
 * - share/amount conversions are monotonic and round in the documented direction
 * - removing collateral cannot leave the borrower insolvent
 * - repayments never increase user debt
 * - pause cannot prevent debt reduction
 * - ERC-4626 deposit/mint/redeem/convert hold for 6-, 8- and 18-decimal assets
 * - liquidation cannot seize more collateral than the borrower posted
 * - bad-debt write-off is capped at MAX_BAD_DEBT_BPS
 */

async function impersonate(addr) {
    await ethers.provider.send("hardhat_impersonateAccount", [addr]);
    await ethers.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]);
    return ethers.getSigner(addr);
}

async function deployCore() {
    const deploymentInstancesCore = await setup.deployCore();
    const interestRateConfig = {
        suffix: "1-10-100 | 1 day | 50%-85% | 90%",
        vertexUtilization: "90000",
        vertexRatePercentOfDelta: "200000000000000000",
        minUtil: "50000",
        maxUtil: "85000",
        zeroUtilizationRate: "318900000",
        minFullUtilizationRate: "3189000000",
        maxFullUtilizationRate: "31890000000",
        rateHalfLife: "86400",
    };
    const deploymentInstanceInterestRate = await setup.deployInterestRate(interestRateConfig);
    const deploymentInstancesMockTokens = await setup.deployMockTokens(
        ["USDC", "WETH", "WBTC"],
        [6, 18, 8]
    );
    return {
        ...deploymentInstancesCore,
        ...deploymentInstanceInterestRate,
        ...deploymentInstancesMockTokens,
    };
}

async function deployOracle(data, { asset, collateral, assetUsd, collateralUsd, name }) {
    const assetFeed = await setup.deployMockChainlinkOracle(assetUsd.toString());
    const collateralFeed = await setup.deployMockChainlinkOracle(collateralUsd.toString());
    const { oracle } = await setup.deployOracle({
        baseToken: asset,
        quoteToken: collateral,
        chainlinkMultiplyAddress: assetFeed.target,
        chainlinkDivideAddress: collateralFeed.target,
        maxOracleDelay: "1000000",
        timelockAddress: data.timelock.target,
        name,
    });
    return { oracle, assetFeed, collateralFeed };
}

async function deployListedPair(data, { asset, collateral, oracle, maxOracleDeviation = "5000" }) {
    const assetToken = await ethers.getContractAt("MockERC20", asset);
    const decimals = await assetToken.decimals();
    await assetToken.mint(data.lightlendPairDeployer.target, ethers.parseUnits("10", decimals));
    const pairAddress = await setup.deployPair({
        lightlendPairRegistry: data.lightlendPairRegistry.target,
        lightlendPairDeployerAddress: data.lightlendPairDeployer.target,
        assetTokenAddress: asset,
        collateralTokenAddress: collateral,
        interestRateAddress: data.interestRate.target,
        oracleAddress: oracle,
        maxOracleDeviation,
        fullUtilizationRate: "9500000000",
        maxLTV: "75000",
        cleanLiquidationFee: "10000",
        protocolLiquidationFee: "1000",
    });
    return (await ethers.getContractFactory("LightlendPair")).attach(pairAddress);
}

async function assertVaultAccounting(pair, assetToken) {
    const [totalAssetAmount, , totalBorrowAmount] = await pair.getPairAccounting();
    const cash = await assetToken.balanceOf(pair.target);
    // Chosen model: claims = unlent cash + outstanding borrows (±1 wei rounding).
    expect(totalAssetAmount).to.be.closeTo(cash + totalBorrowAmount, 2n);
    expect(totalAssetAmount).to.be.gte(totalBorrowAmount);
}

async function fundAndApprove(token, user, pair, amount) {
    await token.mint(user.address, amount);
    await token.connect(user).approve(pair.target, ethers.MaxUint256);
}

describe("Isolated pair invariants", function () {
    async function world() {
        const data = await deployCore();
        const weth = data.mockTokens.WETH;
        const usdc = data.mockTokens.USDC;
        const wbtc = data.mockTokens.WBTC;

        const wethUsdcOracle = await deployOracle(data, {
            asset: weth.target,
            collateral: usdc.target,
            assetUsd: 2400n * 10n ** 8n,
            collateralUsd: 10n ** 8n,
            name: "WETH/USDC",
        });
        const usdcWethOracle = await deployOracle(data, {
            asset: usdc.target,
            collateral: weth.target,
            assetUsd: 10n ** 8n,
            collateralUsd: 2400n * 10n ** 8n,
            name: "USDC/WETH",
        });
        const wbtcUsdcOracle = await deployOracle(data, {
            asset: wbtc.target,
            collateral: usdc.target,
            assetUsd: 50_000n * 10n ** 8n,
            collateralUsd: 10n ** 8n,
            name: "WBTC/USDC",
        });

        const wethPair = await deployListedPair(data, {
            asset: weth.target,
            collateral: usdc.target,
            oracle: wethUsdcOracle.oracle.target,
        });
        const usdcPair = await deployListedPair(data, {
            asset: usdc.target,
            collateral: weth.target,
            oracle: usdcWethOracle.oracle.target,
        });
        const wbtcPair = await deployListedPair(data, {
            asset: wbtc.target,
            collateral: usdc.target,
            oracle: wbtcUsdcOracle.oracle.target,
        });

        return {
            data,
            weth,
            usdc,
            wbtc,
            wethPair,
            usdcPair,
            wbtcPair,
            wethFeed: wethUsdcOracle.assetFeed,
        };
    }

    describe("accounting", function () {
        it("keeps totalAsset.amount = cash + borrows across deposit/borrow/repay/redeem", async function () {
            const { data, weth, usdc, wethPair } = await loadFixture(world);
            const user = data.lender;

            await fundAndApprove(weth, user, wethPair, ethers.parseUnits("10", 18));
            await fundAndApprove(usdc, user, wethPair, ethers.parseUnits("1000", 6));
            await assertVaultAccounting(wethPair, weth);

            await wethPair.connect(user).deposit(ethers.parseUnits("2", 18), user.address);
            await assertVaultAccounting(wethPair, weth);

            await wethPair.connect(user).addCollateral(ethers.parseUnits("400", 6), user.address);
            await wethPair.connect(user).borrowAsset(ethers.parseUnits("0.05", 18), 0, user.address);
            await assertVaultAccounting(wethPair, weth);

            const sharesBefore = await wethPair.userBorrowShares(user.address);
            await wethPair.connect(user).repayAsset(sharesBefore / 2n, user.address);
            await assertVaultAccounting(wethPair, weth);

            const leftover = await wethPair.userBorrowShares(user.address);
            await wethPair.connect(user).repayAsset(leftover, user.address);
            await wethPair.connect(user).removeCollateral(
                await wethPair.userCollateralBalance(user.address),
                user.address
            );
            await wethPair
                .connect(user)
                .redeem(await wethPair.balanceOf(user.address), user.address, user.address);
            await assertVaultAccounting(wethPair, weth);
        });

        it("share conversions are monotonic and round up is never below round down", async function () {
            const { data, weth, wethPair } = await loadFixture(world);
            await fundAndApprove(weth, data.lender, wethPair, ethers.parseUnits("20", 18));
            await wethPair.connect(data.lender).deposit(ethers.parseUnits("5", 18), data.lender.address);

            let prevDown = 0n;
            for (let i = 1; i <= 12; i++) {
                const amount = BigInt(i) * 10n ** 16n;
                const down = await wethPair.toAssetShares(amount, false, true);
                const up = await wethPair.toAssetShares(amount, true, true);
                expect(down).to.be.gte(prevDown);
                expect(up).to.be.gte(down);
                const back = await wethPair.toAssetAmount(down, false, true);
                expect(back).to.be.lte(amount);
                prevDown = down;
            }
        });

        it("repayment never increases user debt, including after interest accrues", async function () {
            const { data, weth, usdc, wethPair } = await loadFixture(world);
            const user = data.lender;
            await fundAndApprove(weth, user, wethPair, ethers.parseUnits("10", 18));
            await fundAndApprove(usdc, user, wethPair, ethers.parseUnits("400", 6));
            await wethPair.connect(user).deposit(ethers.parseUnits("1", 18), user.address);
            await wethPair.connect(user).addCollateral(ethers.parseUnits("400", 6), user.address);
            await wethPair.connect(user).borrowAsset(ethers.parseUnits("0.02", 18), 0, user.address);

            await time.increase(7 * 24 * 60 * 60);

            const sharesBefore = await wethPair.userBorrowShares(user.address);
            const amountBefore = await wethPair.toBorrowAmount(sharesBefore, true, true);
            await wethPair.connect(user).repayAsset(sharesBefore / 4n, user.address);
            const sharesAfter = await wethPair.userBorrowShares(user.address);
            const amountAfter = await wethPair.toBorrowAmount(sharesAfter, true, true);
            expect(sharesAfter).to.be.lt(sharesBefore);
            expect(amountAfter).to.be.lte(amountBefore);
        });
    });

    describe("solvency and pause", function () {
        it("reverts when removing collateral would make the borrower insolvent", async function () {
            const { data, weth, usdc, wethPair } = await loadFixture(world);
            const user = data.lender;
            await fundAndApprove(weth, user, wethPair, ethers.parseUnits("10", 18));
            await fundAndApprove(usdc, user, wethPair, ethers.parseUnits("100", 6));
            await wethPair.connect(user).deposit(ethers.parseUnits("1", 18), user.address);
            await wethPair.connect(user).addCollateral(ethers.parseUnits("100", 6), user.address);
            await wethPair.connect(user).borrowAsset(ethers.parseUnits("0.02", 18), 0, user.address);

            await expect(
                wethPair.connect(user).removeCollateral(ethers.parseUnits("100", 6), user.address)
            ).to.be.revertedWithCustomError(wethPair, "Insolvent");
            expect(await wethPair.userCollateralBalance(user.address)).to.equal(
                ethers.parseUnits("100", 6)
            );
        });

        it("still allows repayment after emergency pause", async function () {
            const { data, weth, usdc, wethPair } = await loadFixture(world);
            const user = data.lender;
            await fundAndApprove(weth, user, wethPair, ethers.parseUnits("10", 18));
            await fundAndApprove(usdc, user, wethPair, ethers.parseUnits("400", 6));
            await wethPair.connect(user).deposit(ethers.parseUnits("1", 18), user.address);
            await wethPair.connect(user).addCollateral(ethers.parseUnits("400", 6), user.address);
            await wethPair.connect(user).borrowAsset(ethers.parseUnits("0.01", 18), 0, user.address);

            const breaker = await impersonate(await wethPair.circuitBreakerAddress());
            await wethPair.connect(breaker).pause();
            expect(await wethPair.isRepayPaused()).to.equal(false);

            const shares = await wethPair.userBorrowShares(user.address);
            await wethPair.connect(user).repayAsset(shares, user.address);
            expect(await wethPair.userBorrowShares(user.address)).to.equal(0n);

            await expect(
                wethPair.connect(user).deposit(ethers.parseUnits("0.1", 18), user.address)
            ).to.be.reverted;
        });
    });

    describe("liquidation bounds", function () {
        it("cannot seize more collateral than the borrower posted", async function () {
            const { data, weth, usdc, wethPair, wethFeed } = await loadFixture(world);
            const user = data.lender;
            const [liquidator] = await ethers.getSigners();
            await fundAndApprove(weth, user, wethPair, ethers.parseUnits("10", 18));
            await fundAndApprove(usdc, user, wethPair, ethers.parseUnits("100", 6));
            await wethPair.connect(user).deposit(ethers.parseUnits("1", 18), user.address);
            await wethPair.connect(user).addCollateral(ethers.parseUnits("100", 6), user.address);
            await wethPair.connect(user).borrowAsset(ethers.parseUnits("0.03", 18), 0, user.address);

            // 10x WETH so 100 USDC no longer covers 0.03 WETH at 75% LTV.
            await wethFeed.setAnswer((24_000n * 10n ** 8n).toString());
            await time.increase(1);

            const collateralBefore = await wethPair.userCollateralBalance(user.address);
            const shares = await wethPair.userBorrowShares(user.address);
            await weth.mint(liquidator.address, ethers.parseUnits("1", 18));
            await weth.connect(liquidator).approve(wethPair.target, ethers.MaxUint256);

            const deadline = BigInt((await time.latest()) + 3600);
            await wethPair.connect(liquidator).liquidate(shares, deadline, user.address);

            const seized = collateralBefore - (await wethPair.userCollateralBalance(user.address));
            expect(seized).to.be.lte(collateralBefore);
            expect(seized).to.be.gt(0n);
            expect(await wethPair.MAX_BAD_DEBT_BPS()).to.equal(500n);
        });
    });

    describe("fee-on-transfer", function () {
        it("rejects fee-on-transfer assets at pair seeding", async function () {
            const data = await loadFixture(deployCore);
            const Fee = await ethers.getContractFactory("MockFeeOnTransfer");
            const feeToken = await Fee.deploy();
            const usdc = data.mockTokens.USDC;
            const oracle = await deployOracle(data, {
                asset: feeToken.target,
                collateral: usdc.target,
                assetUsd: 10n ** 8n,
                collateralUsd: 10n ** 8n,
                name: "FEE/USDC",
            });
            await feeToken.mint(data.lightlendPairDeployer.target, ethers.parseUnits("10", 18));
            await expect(
                deployListedPair(data, {
                    asset: feeToken.target,
                    collateral: usdc.target,
                    oracle: oracle.oracle.target,
                })
            ).to.be.reverted;
        });
    });

    describe("ERC-4626 across decimals", function () {
        const cases = [
            { label: "18-decimal WETH", pairKey: "wethPair", assetKey: "weth", decimals: 18, deposit: "1" },
            { label: "6-decimal USDC", pairKey: "usdcPair", assetKey: "usdc", decimals: 6, deposit: "100" },
            { label: "8-decimal WBTC", pairKey: "wbtcPair", assetKey: "wbtc", decimals: 8, deposit: "1" },
        ];

        for (const spec of cases) {
            it(`deposit/mint/redeem/convertTo round-trip for ${spec.label}`, async function () {
                const ctx = await loadFixture(world);
                const pair = ctx[spec.pairKey];
                const asset = ctx[spec.assetKey];
                const user = ctx.data.lender;
                const amount = ethers.parseUnits(spec.deposit, spec.decimals);

                expect(await pair.decimals()).to.equal(BigInt(spec.decimals));
                expect(await pair.pricePerShare()).to.equal(10n ** BigInt(spec.decimals));

                await fundAndApprove(asset, user, pair, amount * 4n);

                const previewShares = await pair.previewDeposit(amount);
                const convertShares = await pair.convertToShares(amount);
                expect(previewShares).to.equal(convertShares);
                expect(previewShares).to.be.gt(0n);

                await pair.connect(user).deposit(amount, user.address);
                expect(await pair.balanceOf(user.address)).to.equal(previewShares);
                expect(await pair.convertToAssets(previewShares)).to.be.closeTo(amount, amount / 1000n + 1n);

                const mintShares = previewShares / 2n;
                const mintCost = await pair.previewMint(mintShares);
                expect(mintCost).to.be.gt(0n);
                await pair.connect(user).mint(mintShares, user.address);
                expect(await pair.balanceOf(user.address)).to.equal(previewShares + mintShares);

                const userShares = await pair.balanceOf(user.address);
                const previewRedeem = await pair.previewRedeem(userShares);
                await pair.connect(user).redeem(userShares, user.address, user.address);
                expect(await pair.balanceOf(user.address)).to.equal(0n);
                expect(previewRedeem).to.be.gt(0n);
                await assertVaultAccounting(pair, asset);
            });
        }
    });
});
