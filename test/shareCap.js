const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const setup = require("./utils/setup");

/**
 * Audit fixes v1, F3 (audit 2026-11-21 N-ISO-01): liquidate() and repayAsset() cap the share
 * argument to the borrower's shares instead of underflowing. Before, a borrower (or anyone) who
 * repaid one share just before an exact-share liquidate() or a victim's repay-all made it revert.
 * Events and return values carry the capped value; a repayAsset() whose capped share count is zero
 * reverts NothingToRepay(); liquidating a borrower without debt still reverts BorrowerSolvent().
 * The write-off rule is unchanged: a capped call behaves exactly like the exact-share call.
 */

const usdc6 = (x) => ethers.parseUnits(x, 6);
const weth18 = (x) => ethers.parseUnits(x, 18);
const E8 = 10n ** 8n;
const U128_MAX = 2n ** 128n - 1n;
const EIP170_LIMIT = 24_576;


async function fund(token, who, pair, amount) {
    await token.mint(who.address, amount);
    await token.connect(who).approve(pair.target, ethers.MaxUint256);
}

function events(contract, rc, name) {
    return rc.logs
        .map((l) => {
            try {
                return contract.interface.parseLog(l);
            } catch (_) {
                return null;
            }
        })
        .filter((l) => l && l.name === name);
}

/// Full deploy through LightlendPairDeployer with the launch fees (clean 5%, protocol 10% of the
/// bonus): asset WETH (18 dec), collateral USDC (6 dec), WETH = $2,400. Lender: 10 WETH. Borrower:
/// 0.7 WETH against 2,300 USDC (LTV 73.0%). A second, healthy borrower keeps other debt in the pair.
/// Zero interest rate, so a static call and the mined call compute the same amounts.
async function fixture() {
    const core = await setup.deployCore();
    const interestRate = await (await ethers.getContractFactory("LinearInterestRate")).deploy("zero", 80000, 0, 0, 0);
    const { mockTokens } = await setup.deployMockTokens(["USDC", "WETH"], [6, 18]);
    const usdc = mockTokens.USDC;
    const weth = mockTokens.WETH;
    const wethFeed = await setup.deployMockChainlinkOracle((2400n * E8).toString());
    const usdcFeed = await setup.deployMockChainlinkOracle(E8.toString());
    const { oracle } = await setup.deployOracle({
        baseToken: weth.target,
        quoteToken: usdc.target,
        chainlinkMultiplyAddress: wethFeed.target,
        chainlinkDivideAddress: usdcFeed.target,
        maxOracleDelay: "1000000",
        timelockAddress: core.timelock.target,
        name: "af2",
    });
    await weth.mint(core.lightlendPairDeployer.target, weth18("1"));
    const pairAddress = await setup.deployPair({
        lightlendPairRegistry: core.lightlendPairRegistry.target,
        lightlendPairDeployerAddress: core.lightlendPairDeployer.target,
        assetTokenAddress: weth.target,
        collateralTokenAddress: usdc.target,
        interestRateAddress: interestRate.target,
        oracleAddress: oracle.target,
        maxOracleDeviation: "5000",
        fullUtilizationRate: "9500000000",
        maxLTV: "75000",
        cleanLiquidationFee: "5000",
        protocolLiquidationFee: "10000",
    });
    const pair = (await ethers.getContractFactory("LightlendPair")).attach(pairAddress);
    const [, , , , lender, borrower, liquidator, other, borrower2] = await ethers.getSigners();

    await fund(weth, lender, pair, weth18("10"));
    await pair.connect(lender).deposit(weth18("10"), lender.address);
    await fund(usdc, borrower, pair, usdc6("2300"));
    await pair.connect(borrower).borrowAsset(weth18("0.7"), usdc6("2300"), borrower.address);
    await fund(usdc, borrower2, pair, usdc6("10000"));
    await pair.connect(borrower2).borrowAsset(weth18("1"), usdc6("10000"), borrower2.address);
    // repayers and the liquidator hold WETH and have approved the pair
    await fund(weth, borrower, pair, weth18("1"));
    await fund(weth, other, pair, weth18("1"));
    await fund(weth, liquidator, pair, weth18("5"));
    await time.increase(60);
    return { pair, usdc, weth, wethFeed, lender, borrower, liquidator, other, borrower2 };
}

const setWethUsd = (ctx, usd) => ctx.wethFeed.setAnswer((usd * E8).toString());
const deadline = async () => BigInt(await time.latest()) + 3600n;
const shares = (ctx, who) => ctx.pair.userBorrowShares(who.address);

/// The pair state a liquidation or repayment touches, for exact before/after comparisons.
async function pairState(ctx) {
    const { pair, usdc, weth, borrower, liquidator } = ctx;
    const [ta, tb] = await Promise.all([pair.totalAsset(), pair.totalBorrow()]);
    return {
        totalAsset: [ta[0], ta[1]],
        totalBorrow: [tb[0], tb[1]],
        borrowerShares: await pair.userBorrowShares(borrower.address),
        borrowerCollateral: await pair.userCollateralBalance(borrower.address),
        pairCollateral: await pair.userCollateralBalance(pair.target),
        liquidatorWeth: await weth.balanceOf(liquidator.address),
        liquidatorUsdc: await usdc.balanceOf(liquidator.address),
        pairWeth: await weth.balanceOf(pair.target),
    };
}

/// Sends liquidate(shareArg) at timestamp `at` and returns the event args, state and return value.
async function liquidateAt(ctx, shareArg, at) {
    const { pair, borrower, liquidator } = ctx;
    const dl = BigInt(at) + 3600n;
    await time.setNextBlockTimestamp(at);
    const rc = await (await pair.connect(liquidator).liquidate(shareArg, dl, borrower.address)).wait();
    const [liq] = events(pair, rc, "Liquidate");
    const [repay] = events(pair, rc, "RepayAsset");
    const writeOff = events(pair, rc, "WriteOffResidualDebt").map((e) => e.args.amount);
    return {
        liquidate: liq.args.toArray(),
        repay: repay.args.toArray(),
        writeOff,
        state: await pairState(ctx),
    };
}

async function snapshotRun(fn) {
    const id = await network.provider.send("evm_snapshot", []);
    try {
        return await fn();
    } finally {
        await network.provider.send("evm_revert", [id]);
    }
}

describe("F3: share arguments are capped to the borrower's shares (N-ISO-01)", function () {
    describe("N-ISO-01 regressions: a 1-share repay just before the call", function () {
        for (const [path, wethUsd] of [
            ["dirty", 2500n], // LTV 76.1%: insolvent, full repayment leaves collateral (dirty path)
            ["clean", 3400n], // debt 2,380 USDC > 2,300 collateral: under water (clean path)
        ]) {
            it(`an exact full liquidate() on the ${path} path still goes through and clears the position`, async function () {
                const ctx = await loadFixture(fixture);
                const { pair, borrower, liquidator, usdc } = ctx;
                await setWethUsd(ctx, wethUsd);
                const n = await shares(ctx, borrower); // what the liquidator read
                await pair.connect(borrower).repayAsset(1n, borrower.address); // the borrower's dust repay lands first
                expect(await shares(ctx, borrower)).to.equal(n - 1n);

                const dl = await deadline();
                const collateral = await pair.connect(liquidator).liquidate.staticCall(n, dl, borrower.address);
                const usdcBefore = await usdc.balanceOf(liquidator.address);
                const rc = await (await pair.connect(liquidator).liquidate(n, dl, borrower.address)).wait();
                const [liq] = events(pair, rc, "Liquidate");
                const [repay] = events(pair, rc, "RepayAsset");

                expect(liq.args._sharesToLiquidate).to.equal(n - 1n); // the capped value
                expect(liq.args._sharesToAdjust).to.equal(0n); // every remaining share was repaid
                expect(repay.args.shares).to.equal(n - 1n);
                expect(repay.args.amountToRepay).to.equal(liq.args._amountLiquidatorToRepay);
                expect(await usdc.balanceOf(liquidator.address) - usdcBefore).to.equal(collateral);
                expect(liq.args._collateralForLiquidator).to.equal(collateral);
                expect(await shares(ctx, borrower)).to.equal(0n);
                if (path === "clean") expect(await pair.userCollateralBalance(borrower.address)).to.equal(0n);
                else expect(await pair.userCollateralBalance(borrower.address)).to.be.greaterThan(0n);
            });
        }

        it("a victim's repay-all still goes through after a third party repaid one of its shares", async function () {
            const ctx = await loadFixture(fixture);
            const { pair, weth, borrower, other } = ctx;
            const n = await shares(ctx, borrower); // what the victim read
            await pair.connect(other).repayAsset(1n, borrower.address); // anyone may repay for anyone
            const owed = await pair.toBorrowAmount(n - 1n, true, true);

            const ret = await pair.connect(borrower).repayAsset.staticCall(n, borrower.address);
            const before = await weth.balanceOf(borrower.address);
            const rc = await (await pair.connect(borrower).repayAsset(n, borrower.address)).wait();
            const [repay] = events(pair, rc, "RepayAsset");

            expect(repay.args.shares).to.equal(n - 1n); // the capped value
            expect(repay.args.amountToRepay).to.equal(ret);
            expect(before - (await weth.balanceOf(borrower.address))).to.equal(repay.args.amountToRepay);
            expect(repay.args.amountToRepay).to.equal(owed);
            expect(await shares(ctx, borrower)).to.equal(0n);
        });

        it("repayAsset(type(uint256).max) repays exactly the borrower's shares", async function () {
            const ctx = await loadFixture(fixture);
            const { pair, borrower } = ctx;
            const n = await shares(ctx, borrower);
            const rc = await (await pair.connect(borrower).repayAsset(ethers.MaxUint256, borrower.address)).wait();
            const [repay] = events(pair, rc, "RepayAsset");
            expect(repay.args.shares).to.equal(n);
            expect(await shares(ctx, borrower)).to.equal(0n);
        });
    });

    describe("zero cap", function () {
        it("repayAsset(0) on a borrower with debt reverts NothingToRepay", async function () {
            const { pair, borrower } = await loadFixture(fixture);
            await expect(pair.connect(borrower).repayAsset(0n, borrower.address)).to.be.revertedWithCustomError(
                pair,
                "NothingToRepay",
            );
        });

        it("a partial repay that lands after a third party repaid everything reverts NothingToRepay", async function () {
            const ctx = await loadFixture(fixture);
            const { pair, borrower, other } = ctx;
            const n = await shares(ctx, borrower);
            await pair.connect(other).repayAsset(n, borrower.address);
            expect(await shares(ctx, borrower)).to.equal(0n);
            await expect(pair.connect(borrower).repayAsset(n / 2n, borrower.address)).to.be.revertedWithCustomError(
                pair,
                "NothingToRepay",
            );
        });

        it("repaying for an account that never borrowed reverts NothingToRepay", async function () {
            const { pair, lender, other } = await loadFixture(fixture);
            await expect(pair.connect(other).repayAsset(1n, lender.address)).to.be.revertedWithCustomError(
                pair,
                "NothingToRepay",
            );
        });

        it("liquidating a borrower without debt still ends in BorrowerSolvent", async function () {
            const ctx = await loadFixture(fixture);
            const { pair, borrower, liquidator, other, lender } = ctx;
            await setWethUsd(ctx, 3400n); // the borrower is under water ...
            const n = await shares(ctx, borrower);
            await pair.connect(other).repayAsset(n, borrower.address); // ... until a third party repays it all
            await expect(
                pair.connect(liquidator).liquidate(n, await deadline(), borrower.address),
            ).to.be.revertedWithCustomError(pair, "BorrowerSolvent");
            await expect(
                pair.connect(liquidator).liquidate(1n, await deadline(), lender.address),
            ).to.be.revertedWithCustomError(pair, "BorrowerSolvent");
        });
    });

    describe("a capped call behaves exactly like the exact-share call", function () {
        for (const [path, wethUsd] of [
            ["clean", 3400n],
            ["dirty", 2500n],
        ]) {
            it(`${path} path: same write-off, repayment, collateral and totals`, async function () {
                const ctx = await loadFixture(fixture);
                const { pair, borrower } = ctx;
                await setWethUsd(ctx, wethUsd);
                const at = (await time.latest()) + 10;
                const n = await shares(ctx, borrower);

                const exact = await snapshotRun(() => liquidateAt(ctx, n, at));
                for (const arg of [n + 1n, U128_MAX]) {
                    const capped = await snapshotRun(() => liquidateAt(ctx, arg, at));
                    expect(capped, `liquidate(${arg})`).to.deep.equal(exact);
                }
                expect(exact.liquidate[2]).to.equal(n); // _sharesToLiquidate
                if (path === "clean") expect(exact.state.borrowerCollateral).to.equal(0n);

                // after a 1-share repay: liquidate(n) behaves like liquidate(n - 1)
                await pair.connect(borrower).repayAsset(1n, borrower.address);
                const at2 = (await time.latest()) + 10;
                const exact2 = await snapshotRun(() => liquidateAt(ctx, n - 1n, at2));
                const capped2 = await snapshotRun(() => liquidateAt(ctx, n, at2));
                expect(capped2).to.deep.equal(exact2);
                expect(exact2.liquidate[2]).to.equal(n - 1n);
            });
        }

        it("clean path with a partial share count is untouched by the cap: the rest is written off", async function () {
            const ctx = await loadFixture(fixture);
            const { pair, borrower } = ctx;
            await setWethUsd(ctx, 3400n);
            const n = await shares(ctx, borrower);
            const at = (await time.latest()) + 10;
            // 95% of the shares: 0.95 x 2,380 x 1.05 >= 2,300 USDC of collateral, so still the clean path
            const partial = await snapshotRun(() => liquidateAt(ctx, n - n / 20n, at));
            expect(partial.liquidate[2]).to.equal(n - n / 20n); // _sharesToLiquidate
            expect(partial.liquidate[5]).to.equal(n / 20n); // _sharesToAdjust: written off
            expect(partial.liquidate[6]).to.be.greaterThan(0n); // _amountToAdjust
            expect(partial.state.borrowerShares).to.equal(0n);
        });
    });

    it(`LightlendPair deployed bytecode stays under the EIP-170 limit (${EIP170_LIMIT} bytes)`, async function () {
        const { deployedBytecode } = await artifacts.readArtifact("LightlendPair");
        const size = (deployedBytecode.length - 2) / 2;
        console.log(`      LightlendPair deployed bytecode: ${size} bytes`);
        expect(size).to.be.at.most(EIP170_LIMIT);
    });
});
