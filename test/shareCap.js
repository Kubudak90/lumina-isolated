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
const YEAR = 365 * 86_400;
const R10 = 3_170_979_198n; // ~10% APR per second, 1e18 precision

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
/// 0.7 WETH against 2,300 USDC (LTV 73.0%). Repayers and the liquidator hold WETH and have approved.
async function deployFunded(interestRate) {
    const core = await setup.deployCore();
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
    await fund(weth, borrower, pair, weth18("1"));
    await fund(weth, other, pair, weth18("1"));
    await fund(weth, liquidator, pair, weth18("5"));
    return { pair, usdc, weth, wethFeed, lender, borrower, liquidator, other, borrower2 };
}

/// Zero interest rate (shares == amounts); a second, healthy borrower keeps other debt in the pair.
async function fixture() {
    const interestRate = await (await ethers.getContractFactory("LinearInterestRate")).deploy("zero", 80000, 0, 0, 0);
    const ctx = await deployFunded(interestRate);
    const { pair, usdc, borrower2 } = ctx;
    await fund(usdc, borrower2, pair, usdc6("10000"));
    await pair.connect(borrower2).borrowAsset(weth18("1"), usdc6("10000"), borrower2.address);
    await time.increase(60);
    return ctx;
}

/// Review r1: the borrower is the pair's only borrower and a year of ~10% interest has accrued, so a
/// share is worth ~1.1 wei and burning the last share leaves a residue (WriteOffResidualDebt).
async function soleBorrowerFixture() {
    const LIR = await ethers.getContractFactory("LinearInterestRate");
    const ctx = await deployFunded(await LIR.deploy("flat10", 80000, R10, R10, R10));
    await time.increase(YEAR);
    await ctx.pair.addInterest(false);
    return ctx;
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

/// Static call evaluated in the next block at timestamp `at`, then the same call mined at `at`, so
/// the quoted return value is exactly what the transaction returned (also with interest accruing).
async function quoteAndSend(fn, args, at) {
    await time.setNextBlockTimestamp(at);
    const quoted = await fn.staticCall(...args, { blockTag: "pending" });
    await time.setNextBlockTimestamp(at);
    const rc = await (await fn(...args)).wait();
    expect((await ethers.provider.getBlock(rc.blockNumber)).timestamp).to.equal(at);
    return { quoted, rc };
}

/// Sends liquidate(shareArg) at timestamp `at` and returns the event args, state and return value.
async function liquidateAt(ctx, shareArg, at) {
    const { pair, borrower, liquidator } = ctx;
    const dl = BigInt(at) + 3600n;
    const { quoted, rc } = await quoteAndSend(pair.connect(liquidator).liquidate, [shareArg, dl, borrower.address], at);
    const [liq] = events(pair, rc, "Liquidate");
    const [repay] = events(pair, rc, "RepayAsset");
    const writeOff = events(pair, rc, "WriteOffResidualDebt").map((e) => e.args.amount);
    expect(quoted, "liquidate() return value").to.equal(liq.args._collateralForLiquidator);
    return {
        returned: quoted,
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

        // Review r1, item 1: the cap clamps a partial clean-path liquidation.
        for (const [outcome, repaid, path] of [
            ["stays on the clean path", weth18("0.05"), "clean"], // 0.65 x 3,400 x 1.05 = 2,320.5 >= 2,300 USDC
            ["flips from the clean to the dirty path", weth18("0.07"), "dirty"], // 0.63 x 3,400 x 1.05 = 2,249.1 < 2,300
        ]) {
            it(`a partial clean-path liquidate() above what a third party's repay left is capped and ${outcome}`, async function () {
                const ctx = await loadFixture(fixture);
                const { pair, borrower, other } = ctx;
                await setWethUsd(ctx, 3400n);
                const n = await shares(ctx, borrower);
                const s = n - n / 20n; // what the liquidator planned: a clean partial that writes off n/20

                const at = (await time.latest()) + 10;
                const planned = await snapshotRun(() => liquidateAt(ctx, s, at));
                expect(planned.liquidate[5]).to.equal(n / 20n); // _sharesToAdjust
                expect(planned.state.borrowerCollateral).to.equal(0n); // clean

                await pair.connect(other).repayAsset(repaid, borrower.address); // zero interest: shares == amount
                const left = await shares(ctx, borrower);
                expect(left).to.equal(n - repaid);
                expect(left).to.be.lessThan(s);

                const at2 = (await time.latest()) + 10;
                const capped = await snapshotRun(() => liquidateAt(ctx, s, at2));
                const exact = await snapshotRun(() => liquidateAt(ctx, left, at2));
                expect(capped).to.deep.equal(exact);
                expect(capped.liquidate[2]).to.equal(left); // _sharesToLiquidate: capped
                expect(capped.liquidate[5]).to.equal(0n); // _sharesToAdjust: no underflow, nothing written off
                expect(capped.liquidate[6]).to.equal(0n); // _amountToAdjust
                expect(capped.writeOff).to.deep.equal([]);
                expect(capped.state.borrowerShares).to.equal(0n);
                if (path === "clean") expect(capped.state.borrowerCollateral).to.equal(0n);
                else expect(capped.state.borrowerCollateral).to.be.greaterThan(0n);
            });
        }
    });

    // Review r1, item 2: shares != amounts, and the capped call burns the pair's last borrow share.
    describe("sole borrower with accrued interest: a capped call burns the last share", function () {
        async function check(ctx, { payer, send, expectRepaid }) {
            const { pair, weth, borrower } = ctx;
            const tb0 = await pair.totalBorrow();
            const n = await shares(ctx, borrower);
            expect(tb0[1], "sole borrower").to.equal(n);
            expect(tb0[0], "a share is worth more than 1 wei").to.be.greaterThan(tb0[1] + tb0[1] / 20n);

            await pair.connect(ctx.other).repayAsset(1n, borrower.address); // the third party's 1-share repay
            const at = (await time.latest()) + 10;
            const [ta1, tb1] = [await pair.totalAsset(), await pair.totalBorrow()];
            const [cash1, payer1] = [await weth.balanceOf(pair.target), await weth.balanceOf(payer.address)];
            const { quoted, rc } = await send(n, at);

            const [repay] = events(pair, rc, "RepayAsset");
            const [interest] = events(pair, rc, "AddInterest");
            const writeOffs = events(pair, rc, "WriteOffResidualDebt");
            const earned = interest ? interest.args.interestEarned : 0n;
            const repaid = repay.args.amountToRepay;
            expect(repay.args.shares).to.equal(n - 1n); // capped
            expect(await shares(ctx, borrower)).to.equal(0n);
            expectRepaid(rc, quoted, repaid);
            expect(payer1 - (await weth.balanceOf(payer.address)), "payer's WETH").to.equal(repaid);
            expect((await weth.balanceOf(pair.target)) - cash1, "pair's WETH").to.equal(repaid);

            // the residue no share represents is written off, and nothing is left borrowed
            expect(writeOffs.length).to.equal(1);
            const residue = writeOffs[0].args.amount;
            expect(residue).to.be.greaterThan(0n);
            const [ta2, tb2] = [await pair.totalAsset(), await pair.totalBorrow()];
            expect([tb2[0], tb2[1]]).to.deep.equal([0n, 0n]);
            expect(tb1[0] + earned).to.equal(repaid + residue);
            expect(ta2[0]).to.equal(ta1[0] + earned - residue);
            expect(ta2[0], "totalAsset = cash once nothing is borrowed").to.equal(await weth.balanceOf(pair.target));
            return { repay, residue };
        }

        for (const arg of ["n", "max"]) {
            it(`repayAsset(${arg === "n" ? "n" : "type(uint256).max"}) after a third party's 1-share repay`, async function () {
                const ctx = await loadFixture(soleBorrowerFixture);
                const { pair, borrower } = ctx;
                await check(ctx, {
                    payer: borrower,
                    send: (n, at) =>
                        quoteAndSend(pair.connect(borrower).repayAsset, [arg === "n" ? n : ethers.MaxUint256, borrower.address], at),
                    expectRepaid: (rc, quoted, repaid) => expect(quoted, "repayAsset() return value").to.equal(repaid),
                });
            });
        }

        for (const [path, wethUsd] of [
            ["dirty", 2400n], // LTV ~80% after a year of interest
            ["clean", 3400n], // under water
        ]) {
            it(`liquidate(n) on the ${path} path after a third party's 1-share repay`, async function () {
                const ctx = await loadFixture(soleBorrowerFixture);
                const { pair, usdc, borrower, liquidator } = ctx;
                await setWethUsd(ctx, wethUsd);
                const usdc1 = await usdc.balanceOf(liquidator.address);
                let collateral;
                await check(ctx, {
                    payer: liquidator,
                    send: (n, at) =>
                        quoteAndSend(pair.connect(liquidator).liquidate, [n, BigInt(at) + 3600n, borrower.address], at),
                    expectRepaid: (rc, quoted, repaid) => {
                        const [liq] = events(pair, rc, "Liquidate");
                        const [repay] = events(pair, rc, "RepayAsset");
                        expect(liq.args._sharesToLiquidate).to.equal(repay.args.shares); // capped
                        expect(liq.args._sharesToAdjust).to.equal(0n);
                        expect(liq.args._amountToAdjust).to.equal(0n);
                        expect(liq.args._amountLiquidatorToRepay).to.equal(repaid);
                        expect(quoted, "liquidate() return value").to.equal(liq.args._collateralForLiquidator);
                        collateral = quoted;
                    },
                });
                expect((await usdc.balanceOf(liquidator.address)) - usdc1, "liquidator's USDC").to.equal(collateral);
                if (path === "clean") expect(await pair.userCollateralBalance(borrower.address)).to.equal(0n);
                else expect(await pair.userCollateralBalance(borrower.address)).to.be.greaterThan(0n);
            });
        }
    });

    it(`LightlendPair deployed bytecode stays under the EIP-170 limit (${EIP170_LIMIT} bytes)`, async function () {
        const { deployedBytecode } = await artifacts.readArtifact("LightlendPair");
        const size = (deployedBytecode.length - 2) / 2;
        console.log(`      LightlendPair deployed bytecode: ${size} bytes`);
        expect(size).to.be.at.most(EIP170_LIMIT);
    });
});
