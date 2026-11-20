const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const setup = require("./utils/setup");

/**
 * S5b: isolated accounting.
 * - ISO-02: no bad-debt cap. A clean liquidation (all collateral taken) writes off every remaining
 *   borrow share in the same transaction, so the loss is socialized across lenders at once.
 * - ISO-09: remainder carry (review decision R1-3). lastTimestamp advances on every accrual, and the
 *   truncated interest numerator is carried to the next accrual instead of being lost.
 * - ISO-07: LightlendPairDeployer.globalPause really pauses every listed pair, or reverts.
 * - Leverage paths: with no whitelisted swapper (the Lighter setup) both swap paths revert.
 * Ports PoC-A (ISO-07), PoC-B (ISO-02) and PoC-G (ISO-09) from the review.
 *
 * The ISO-09 models start from a fresh pair, where the carried remainder is provably 0 (every accrual
 * before the first borrow runs on totalBorrow = 0), so they do not depend on the new getter.
 */

const abi = ethers.AbiCoder.defaultAbiCoder();
const E18 = 10n ** 18n;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const DAY = 86_400;
const usdc6 = (x) => ethers.parseUnits(x, 6);
const weth18 = (x) => ethers.parseUnits(x, 18);

// Per-second rates, 1e18 precision
const R1 = 317_097_920n; // ~1% APR
const R10 = 3_170_979_198n; // ~10% APR
const R100 = 31_709_791_983n; // ~100% APR

// Review PoC rate curve (same as the existing suites)
const POC_RATE = {
    suffix: "poc",
    vertexUtilization: "90000",
    vertexRatePercentOfDelta: "200000000000000000",
    minUtil: "50000",
    maxUtil: "85000",
    zeroUtilizationRate: "318900000",
    minFullUtilizationRate: "3189000000",
    maxFullUtilizationRate: "31890000000",
    rateHalfLife: "86400",
};

async function impersonate(addr) {
    await network.provider.send("hardhat_impersonateAccount", [addr]);
    await network.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]);
    return ethers.getSigner(addr);
}

async function fund(token, who, pair, amount) {
    await token.mint(who.address, amount);
    await token.connect(who).approve(pair.target, ethers.MaxUint256);
}

const va = (r) => ({ amount: r[0], shares: r[1] });

// VaultAccountingLibrary with the 1e3/1e3 virtual offset
function vaToAmount(t, shares, roundUp) {
    const A = t.amount + 1000n;
    const S = t.shares + 1000n;
    let a = (shares * A) / S;
    if (roundUp && (a * S) / A < shares) a += 1n;
    return a;
}

function parseEvent(contract, rc, name) {
    return rc.logs
        .map((l) => {
            try {
                return contract.interface.parseLog(l);
            } catch (_) {
                return null;
            }
        })
        .find((l) => l && l.name === name);
}

/// Full deploy through LightlendPairDeployer: asset WETH (18 dec), collateral USDC (6 dec), WETH = $2400.
/// rate: undefined -> review PoC VariableInterestRate; "zero" -> LinearInterestRate with all rates 0;
/// "linear" -> LinearInterestRate 1% / 10% (vertex 80%) / 100% APR.
async function build({
    maxLTV = "75000",
    cleanLiquidationFee = "10000",
    protocolLiquidationFee = "1000",
    rate,
} = {}) {
    const core = await setup.deployCore();
    const LIR = await ethers.getContractFactory("LinearInterestRate");
    let interestRate;
    if (rate === "zero") interestRate = await LIR.deploy("zero", 80000, 0, 0, 0);
    else if (rate === "linear") interestRate = await LIR.deploy("lin", 80000, R1, R10, R100);
    else ({ interestRate } = await setup.deployInterestRate(POC_RATE));
    const { mockTokens } = await setup.deployMockTokens(["USDC", "WETH"], [6, 18]);
    const usdc = mockTokens.USDC;
    const weth = mockTokens.WETH;
    const wethFeed = await setup.deployMockChainlinkOracle((2400n * 10n ** 8n).toString());
    const usdcFeed = await setup.deployMockChainlinkOracle((10n ** 8n).toString());
    const { oracle } = await setup.deployOracle({
        baseToken: weth.target,
        quoteToken: usdc.target,
        chainlinkMultiplyAddress: wethFeed.target,
        chainlinkDivideAddress: usdcFeed.target,
        maxOracleDelay: "1000000",
        timelockAddress: core.timelock.target,
        name: "s5b",
    });
    await weth.mint(core.lightlendPairDeployer.target, weth18("1"));
    const pairConfig = {
        lightlendPairRegistry: core.lightlendPairRegistry.target,
        lightlendPairDeployerAddress: core.lightlendPairDeployer.target,
        assetTokenAddress: weth.target,
        collateralTokenAddress: usdc.target,
        interestRateAddress: interestRate.target,
        oracleAddress: oracle.target,
        maxOracleDeviation: "5000",
        fullUtilizationRate: "9500000000",
        maxLTV,
        cleanLiquidationFee,
        protocolLiquidationFee,
    };
    const pair = (await ethers.getContractFactory("LightlendPair")).attach(await setup.deployPair(pairConfig));
    const signers = await ethers.getSigners();
    const [, , , , lenderA, lenderB, borrower, liquidator, borrower2] = signers;
    return { core, pair, usdc, weth, wethFeed, oracle, interestRate, pairConfig, lenderA, lenderB, borrower, liquidator, borrower2 };
}

// =================================================================================================
// ISO-02 fixtures
// =================================================================================================

/// PoC-B: lenders A and B deposit 1 WETH each; the borrower takes 0.9 WETH against 2,900 USDC; WETH 10x.
async function fxPocB() {
    const ctx = await build();
    const { pair, usdc, weth, wethFeed, lenderA, lenderB, borrower, liquidator } = ctx;
    await fund(weth, lenderA, pair, weth18("1"));
    await fund(weth, lenderB, pair, weth18("1"));
    await pair.connect(lenderA).deposit(weth18("1"), lenderA.address);
    await pair.connect(lenderB).deposit(weth18("1"), lenderB.address);
    await fund(usdc, borrower, pair, usdc6("2900"));
    await pair.connect(borrower).borrowAsset(weth18("0.9"), usdc6("2900"), borrower.address);
    await fund(weth, liquidator, pair, weth18("1"));
    await wethFeed.setAnswer((24000n * 10n ** 8n).toString()); // 10x
    await time.increase(10);
    return ctx;
}

/// PoC-B's liquidation: repay just enough that repaid * (1 + 10%) >= collateral (clean path).
async function pocBLiquidate({ pair, borrower, liquidator }) {
    await pair.updateExchangeRate();
    const rate = (await pair.exchangeRateInfo())[5];
    const coll = await pair.userCollateralBalance(borrower.address);
    const repayAmt = (coll * E18 * 100000n) / (rate * 110000n) + 10n ** 12n;
    const shares = await pair.toBorrowShares(repayAmt, true, true);
    const rc = await (await pair.connect(liquidator).liquidate(shares, (await time.latest()) + 3600, borrower.address)).wait();
    return { rc, shares };
}

/// Spec fees (clean 5%, protocol 10% of the bonus) on a zero-rate pair: lender deposits 1 WETH, the
/// borrower takes 0.7 WETH against 2,300 USDC (LTV 73.0% at $2400). At $3500 a liquidation of 0.64 WETH
/// is clean with a positive bonus and leaves 0.06 WETH to write off, above the old 5%-of-assets cap.
async function fxSpecWriteOff() {
    const ctx = await build({ cleanLiquidationFee: "5000", protocolLiquidationFee: "10000", rate: "zero" });
    const { pair, usdc, weth, lenderA, borrower, liquidator } = ctx;
    await fund(weth, lenderA, pair, weth18("1"));
    await pair.connect(lenderA).deposit(weth18("1"), lenderA.address);
    await fund(usdc, borrower, pair, usdc6("2300"));
    await pair.connect(borrower).borrowAsset(weth18("0.7"), usdc6("2300"), borrower.address);
    await fund(weth, liquidator, pair, weth18("1"));
    return ctx;
}

describe("S5b: isolated accounting", function () {
    // =============================================================================================
    // ISO-02
    // =============================================================================================
    describe("ISO-02: immediate socialization, no bad-debt cap", function () {
        for (const firstOut of ["A", "B"]) {
            it(`PoC-B port: both lenders' shares are worth the same after the liquidation (${firstOut} withdraws first)`, async function () {
                const ctx = await loadFixture(fxPocB);
                const { pair, weth, lenderA, lenderB, borrower, liquidator } = ctx;
                const { rc } = await pocBLiquidate(ctx);
                const ev = parseEvent(pair, rc, "Liquidate");
                const collLeft = await pair.userCollateralBalance(borrower.address);
                const sharesLeft = await pair.userBorrowShares(borrower.address);

                const aShares = await pair.balanceOf(lenderA.address);
                expect(aShares).to.equal(await pair.balanceOf(lenderB.address));
                const valueNow = await pair.toAssetAmount(aShares, false, false);

                const [first, second] = firstOut === "A" ? [lenderA, lenderB] : [lenderB, lenderA];
                await pair.connect(first).redeem(await pair.balanceOf(first.address), first.address, first.address);
                const firstGot = await weth.balanceOf(first.address);
                // As in PoC-B: with the old cap the rest of the debt could only be written off by later
                // liquidate(0) calls (5% of assets per day). After ISO-02 nothing is left, so this never runs.
                let laterWriteOffs = 0;
                while ((await pair.userBorrowShares(borrower.address)) > 0n && laterWriteOffs < 40) {
                    await time.increase(DAY);
                    await pair.connect(liquidator).liquidate(0, (await time.latest()) + 3600, borrower.address);
                    laterWriteOffs++;
                }
                await pair.connect(second).redeem(await pair.balanceOf(second.address), second.address, second.address);
                const secondGot = await weth.balanceOf(second.address);
                console.log(
                    `      ${firstOut} out first: first lender got ${ethers.formatUnits(firstGot, 18)} WETH,` +
                        ` second got ${ethers.formatUnits(secondGot, 18)} WETH (both deposited 1.0;` +
                        ` ${laterWriteOffs} later write-offs)`
                );

                // equal within rounding, whichever leaves first; each carries half of the loss
                expect(secondGot).to.be.closeTo(firstGot, 2n);
                expect(firstGot).to.be.closeTo(valueNow, 2n);
                expect(firstGot).to.be.lt(weth18("0.61"));
                expect(firstGot).to.be.gt(weth18("0.60"));
                // the borrower was gone after the liquidation itself: no collateral and no debt
                expect(laterWriteOffs).to.equal(0);
                expect(collLeft).to.equal(0n);
                expect(sharesLeft).to.equal(0n);
                expect(ev.args._amountToAdjust).to.be.gt(weth18("0.7")); // ~0.79 WETH written off at once
            });
        }

        it("nothing keeps accruing on written-off debt", async function () {
            const ctx = await loadFixture(fxPocB);
            const { pair, lenderB } = ctx;
            await pocBLiquidate(ctx);
            const tb0 = va(await pair.totalBorrow());
            const bValue0 = await pair.toAssetAmount(await pair.balanceOf(lenderB.address), false, false);

            await time.increase(365 * DAY);
            await pair.addInterest(false);

            const tb1 = va(await pair.totalBorrow());
            const bValue1 = await pair.toAssetAmount(await pair.balanceOf(lenderB.address), false, false);
            console.log(`      one year after the liquidation: totalBorrow ${tb0.amount} -> ${tb1.amount} wei`);
            // a year of interest on <= 1000 wei of dust: at most a few wei (the old code accrued on ~0.69 WETH)
            expect(tb1.amount - tb0.amount).to.be.lte(10n);
            expect(bValue1 - bValue0).to.be.lte(10n); // lenders' shares are not inflated by phantom interest
            // only the virtual-share rounding dust (~1e3 x (share price - 1) wei) is left, with no shares
            expect(tb0.shares).to.equal(0n);
            expect(tb0.amount).to.be.lte(1000n);
        });

        it("exact totalBorrow / totalAsset deltas: every remaining share is written off in the same transaction", async function () {
            const { pair, usdc, weth, wethFeed, borrower, liquidator, lenderA } = await loadFixture(fxSpecWriteOff);
            await wethFeed.setAnswer((3500n * 10n ** 8n).toString());
            await time.increase(10);
            await pair.updateExchangeRate();
            const low = (await pair.exchangeRateInfo())[4];
            expect(low).to.equal(3_500_000_000n);

            const tb0 = va(await pair.totalBorrow());
            const ta0 = va(await pair.totalAsset());
            const totalColl0 = await pair.totalCollateral();
            const coll = await pair.userCollateralBalance(borrower.address);
            const borrowerShares = await pair.userBorrowShares(borrower.address);
            const lenderValue0 = await pair.toAssetAmount(await pair.balanceOf(lenderA.address), false, false);

            // model (zero rate, so no interest in the liquidation block)
            const s = weth18("0.64");
            const L = (vaToAmount(tb0, s, false) * low) / E18; // 2,240 USDC
            expect((L * 105_000n) / 100_000n).to.be.gte(coll); // clean path
            const fee = (10_000n * (coll - L)) / 100_000n; // 10% of the 60 USDC bonus = 6 USDC
            const repay = vaToAmount(tb0, s, true);
            const sharesToAdjust = borrowerShares - s;
            const amountToAdjust = vaToAmount(tb0, sharesToAdjust, false);
            expect(amountToAdjust).to.equal(weth18("0.06"));
            expect(amountToAdjust).to.be.gt((ta0.amount * 500n) / 10_000n); // above the old 5% cap

            const rc = await (await pair.connect(liquidator).liquidate(s, (await time.latest()) + 3600, borrower.address)).wait();
            const ev = parseEvent(pair, rc, "Liquidate");
            expect(ev.args._sharesToAdjust).to.equal(sharesToAdjust);
            expect(ev.args._amountToAdjust).to.equal(amountToAdjust);
            expect(ev.args._amountLiquidatorToRepay).to.equal(repay);
            expect(ev.args._feesAmount).to.equal(fee);
            expect(ev.args._collateralForLiquidator).to.equal(coll - fee);
            expect(await usdc.balanceOf(liquidator.address)).to.equal(coll - fee);
            expect(weth18("1") - (await weth.balanceOf(liquidator.address))).to.equal(repay);

            const tb1 = va(await pair.totalBorrow());
            const ta1 = va(await pair.totalAsset());
            expect(tb0.amount - tb1.amount).to.equal(repay + amountToAdjust);
            expect(tb0.shares - tb1.shares).to.equal(borrowerShares);
            expect(ta0.amount - ta1.amount).to.equal(amountToAdjust);
            expect(ta1.shares).to.equal(ta0.shares);
            expect(totalColl0 - (await pair.totalCollateral())).to.equal(coll - fee); // the fee stays as protocol collateral

            expect(await pair.userBorrowShares(borrower.address)).to.equal(0n);
            expect(await pair.userCollateralBalance(borrower.address)).to.equal(0n);
            // lenders take the loss now, pro rata
            const lenderShares = await pair.balanceOf(lenderA.address);
            const lenderValue1 = await pair.toAssetAmount(lenderShares, false, false);
            expect(lenderValue0).to.equal(vaToAmount(ta0, lenderShares, false));
            expect(lenderValue1).to.equal(vaToAmount({ amount: ta0.amount - amountToAdjust, shares: ta0.shares }, lenderShares, false));
            expect(lenderValue0 - lenderValue1).to.be.closeTo(amountToAdjust, amountToAdjust / 10n ** 9n); // ~all of it
        });
    });

    // =============================================================================================
    // ISO-09
    // =============================================================================================
    describe("ISO-09: remainder carry (R1-3)", function () {
        /// Exact model of the carried accrual: each step accrues floor((dt * B * rate + carry) / 1e18)
        /// and carries the rest. B grows by the interest (compounding) unless a step gives its own B
        /// (the total borrow read before it, e.g. when a new borrow added principal).
        function carryModel(B0, c0, steps) {
            let B = B0;
            let c = c0;
            let total = 0n;
            const per = [];
            for (const st of steps) {
                const { dt, rate } = st;
                if (st.B !== undefined) B = st.B;
                const n = dt * B * rate + c;
                const I = n / E18;
                c = n % E18;
                B += I;
                total += I;
                per.push(I);
            }
            return { total, per, carry: c };
        }

        /// Sends one accrual and records what the pair did: elapsed time, total borrow before, rate and
        /// interest (from AddInterest).
        async function step(pair, send) {
            const before = await pair.currentRateInfo();
            const B = (await pair.totalBorrow())[0];
            const rc = await (await send()).wait();
            const blk = await ethers.provider.getBlock(rc.blockNumber);
            const ev = parseEvent(pair, rc, "AddInterest");
            return { dt: BigInt(blk.timestamp) - before.lastTimestamp, B, rate: ev.args.rate, interest: ev.args.interestEarned, ts: BigInt(blk.timestamp) };
        }

        async function everySecond(pair, start, n) {
            const steps = [];
            for (let i = 1n; i <= n; i++) {
                await time.setNextBlockTimestamp(start + i);
                steps.push(await step(pair, () => pair.addInterest(false)));
            }
            return steps;
        }

        /// PoC-G: 1e9 wei borrowed at the zero-utilization rate of the review curve.
        async function fxPocG() {
            const ctx = await build();
            const { pair, usdc, weth, lenderA, borrower } = ctx;
            await fund(weth, lenderA, pair, weth18("1"));
            await pair.connect(lenderA).deposit(weth18("1"), lenderA.address);
            await fund(usdc, borrower, pair, usdc6("1000"));
            await pair.connect(borrower).borrowAsset(10n ** 9n, usdc6("1000"), borrower.address);
            return ctx;
        }

        it("PoC-G port: 60 one-second accruals on a 1e9-wei borrow accrue the same as one 60-second accrual (within 1 wei)", async function () {
            const { pair } = await loadFixture(fxPocG);
            const snap = await network.provider.send("evm_snapshot");
            const start = BigInt(await time.latest());
            const b0 = (await pair.totalBorrow())[0];
            await everySecond(pair, start, 60n);
            const perSecond = (await pair.totalBorrow())[0] - b0;
            await network.provider.send("evm_revert", [snap]);
            await time.setNextBlockTimestamp(start + 60n);
            await pair.addInterest(false);
            const once = (await pair.totalBorrow())[0] - b0;
            console.log(`      interest over 60s: accrued every second = ${perSecond} wei; accrued once = ${once} wei`);
            expect(once).to.be.gt(0n);
            expect(perSecond).to.be.closeTo(once, 1n);
        });

        /// LinearInterestRate at a fixed utilization of ~50.015%: lender 0.002 WETH, borrower 0.001000295 WETH,
        /// mid-way inside one 1e-5 utilization step so the accrued interest cannot move the rate. The
        /// principal is small so that compounding over 60 s stays under 60 wei.
        async function fxFixedUtil() {
            const ctx = await build({ rate: "linear" });
            const { pair, usdc, weth, lenderA, borrower } = ctx;
            await fund(weth, lenderA, pair, weth18("0.002"));
            await pair.connect(lenderA).deposit(weth18("0.002"), lenderA.address);
            await fund(usdc, borrower, pair, usdc6("1000"));
            await pair.connect(borrower).borrowAsset(1_000_295_000_000_000n, usdc6("1000"), borrower.address);
            return ctx;
        }

        it("N one-second accruals equal one N-second accrual within N wei (LinearInterestRate, fixed utilization)", async function () {
            const { pair } = await loadFixture(fxFixedUtil);
            const N = 60n;
            const [ta, , tb] = await pair.getPairAccounting();
            expect((100_000n * tb) / ta).to.equal(50_014n);
            const snap = await network.provider.send("evm_snapshot");
            const start = BigInt(await time.latest());
            const b0 = (await pair.totalBorrow())[0];
            const steps = await everySecond(pair, start, N);
            const perSecond = (await pair.totalBorrow())[0] - b0;
            await network.provider.send("evm_revert", [snap]);
            await time.setNextBlockTimestamp(start + N);
            const one = await step(pair, () => pair.addInterest(false));
            const once = one.interest;

            // fixed utilization: every accrual used the same rate
            for (const s of steps) expect(s.rate).to.equal(one.rate);
            // exact carry model from a fresh pair (carry 0 after the first borrow)
            const model = carryModel(b0, 0n, steps.map((s) => ({ dt: 1n, rate: s.rate })));
            console.log(`      N=${N}: every second = ${perSecond} wei (model ${model.total}); once = ${once} wei`);
            expect(perSecond).to.equal(model.total);
            expect(once).to.equal((N * b0 * one.rate) / E18);
            // per-second accrual loses nothing to truncation; the difference is compounding only
            expect(perSecond).to.be.gte(once);
            expect(perSecond - once).to.be.lte(N);
        });

        /// LinearInterestRate pair with one lender (100 WETH) and nothing borrowed yet.
        async function fxIdleLinear() {
            const ctx = await build({ rate: "linear" });
            const { pair, usdc, weth, lenderA, borrower, borrower2 } = ctx;
            await fund(weth, lenderA, pair, weth18("100"));
            await pair.connect(lenderA).deposit(weth18("100"), lenderA.address);
            await fund(usdc, borrower, pair, usdc6("100000"));
            await fund(usdc, borrower2, pair, usdc6("100000"));
            return ctx;
        }

        it("idle pair -> first borrow: an idle stretch with no accrual calls charges no idle interest to the new principal", async function () {
            const { pair, borrower } = await loadFixture(fxIdleLinear);
            const idleFrom = (await pair.currentRateInfo()).lastTimestamp;
            await time.increase(30 * DAY); // idle: no calls at all
            const B = 1_234_567_891_234_567n; // ~0.0012 WETH
            const borrow = await step(pair, () => pair.connect(borrower).borrowAsset(B, usdc6("1000"), borrower.address));
            expect(borrow.dt).to.be.gte(BigInt(30 * DAY)); // the borrow's own accrual covered the idle stretch...
            expect(borrow.B).to.equal(0n); // ...on zero debt
            expect(borrow.interest).to.equal(0n);
            const info = await pair.currentRateInfo();
            expect(info.lastTimestamp).to.equal(borrow.ts); // lastTimestamp advanced although the interest was 0
            expect(info.lastTimestamp).to.be.gt(idleFrom);

            const N = 30n;
            const steps = await everySecond(pair, borrow.ts, N);
            const accrued = (await pair.totalBorrow())[0] - B;
            const model = carryModel(B, 0n, steps.map((s) => ({ dt: s.dt, rate: s.rate })));
            for (const s of steps) expect(s.dt).to.equal(1n);
            // interest only for the N seconds since the borrow, exact with the carry
            expect(accrued).to.equal(model.total);
            // charging the idle stretch (the forbidden "advance only on non-zero interest" variant) would add
            // about 30 days of interest on B
            const idleCharge = (BigInt(30 * DAY) * B * steps[0].rate) / E18;
            console.log(`      ${N}s after the borrow: accrued ${accrued} wei; an idle charge would add ~${idleCharge} wei`);
            expect(accrued).to.be.lt(idleCharge / 1000n);
        });

        it("small debt then large debt: the carried remainder adds at most 1 wei to any accrual", async function () {
            const { pair, borrower, borrower2 } = await loadFixture(fxIdleLinear);
            // small debt: 1e9 wei, ~0.3 wei of interest per second, so every accrual truncates
            const first = await step(pair, () => pair.connect(borrower).borrowAsset(10n ** 9n, usdc6("1"), borrower.address));
            expect(first.B).to.equal(0n);
            const steps = await everySecond(pair, first.ts, 10n);
            // large debt (10 WETH) in the next second: its own accrual still runs on the small debt
            await time.setNextBlockTimestamp(first.ts + 11n);
            steps.push(await step(pair, () => pair.connect(borrower2).borrowAsset(weth18("10"), usdc6("100000"), borrower2.address)));
            const switchIndex = steps.length; // first accrual on the large debt
            steps.push(...(await everySecond(pair, first.ts + 11n, 10n)));
            expect(steps[switchIndex].B).to.be.gt(weth18("10"));

            const model = carryModel(10n ** 9n, 0n, steps.map((s) => ({ dt: s.dt, rate: s.rate, B: s.B })));
            let sumNoCarry = 0n;
            let extras = 0n;
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i];
                const noCarry = (s.dt * s.B * s.rate) / E18;
                expect(s.interest).to.equal(model.per[i]); // exact carried accrual
                const extra = s.interest - noCarry;
                expect(extra).to.be.gte(0n);
                expect(extra).to.be.lte(1n); // the carry is < 1e18, i.e. worth less than 1 wei
                extras += extra;
                sumNoCarry += s.dt * s.B * s.rate;
            }
            // over the whole sequence nothing is lost to truncation and nothing is created
            const total = steps.reduce((a, s) => a + s.interest, 0n);
            expect(total).to.equal(sumNoCarry / E18);
            console.log(`      ${steps.length} accruals: carry added ${extras} wei in total, at most 1 wei per accrual`);
            expect(extras).to.be.gt(0n);
            expect(steps[switchIndex].interest - (steps[switchIndex].dt * steps[switchIndex].B * steps[switchIndex].rate) / E18).to.be.lte(1n);
        });

        it("pause: the carry is frozen while interest is paused and consumed by the first accrual after unpause", async function () {
            const { pair, borrower } = await loadFixture(fxIdleLinear);
            const B = 10n ** 9n + 7n;
            const first = await step(pair, () => pair.connect(borrower).borrowAsset(B, usdc6("1"), borrower.address));
            const steps = await everySecond(pair, first.ts, 3n);
            const cb = await impersonate(await pair.circuitBreakerAddress());
            await time.setNextBlockTimestamp(first.ts + 4n);
            steps.push(await step(pair, () => pair.connect(cb).pause())); // pause() accrues first
            const m = carryModel(B, 0n, steps.map((s) => ({ dt: s.dt, rate: s.rate })));
            expect(m.carry).to.be.gt(0n);
            expect(await pair.interestRemainder()).to.equal(m.carry);
            expect(await pair.isInterestPaused()).to.equal(true);
            const tbPaused = va(await pair.totalBorrow());
            const lastPaused = (await pair.currentRateInfo()).lastTimestamp;

            await time.increase(30 * DAY);
            await pair.addInterest(false); // no-op while paused
            expect(va(await pair.totalBorrow()).amount).to.equal(tbPaused.amount);
            expect(await pair.interestRemainder()).to.equal(m.carry); // frozen, not reset
            expect((await pair.currentRateInfo()).lastTimestamp).to.equal(lastPaused);

            const owner = await impersonate(await pair.owner());
            const unpauseRc = await (await pair.connect(owner).unpause()).wait();
            const tUnpause = BigInt((await ethers.provider.getBlock(unpauseRc.blockNumber)).timestamp);
            expect((await pair.currentRateInfo()).lastTimestamp).to.equal(tUnpause); // the paused stretch is skipped
            expect(await pair.interestRemainder()).to.equal(m.carry); // carried across the pause

            await time.setNextBlockTimestamp(tUnpause + 1n);
            const after = await step(pair, () => pair.addInterest(false));
            expect(after.dt).to.equal(1n);
            const n = after.B * after.rate + m.carry;
            expect(after.interest).to.equal(n / E18);
            expect(await pair.interestRemainder()).to.equal(n % E18);
            expect(await pair.interestRemainder()).to.be.lt(E18);
        });

        it("uint128 ceiling: interest that does not fit is forfeited with its remainder (carry reset to 0)", async function () {
            const ctx = await build({ rate: "zero" });
            const { core, pair, usdc, weth, lenderA, borrower } = ctx;
            const flat = await (await ethers.getContractFactory("LinearInterestRate")).deploy("max", 80000, U64_MAX, U64_MAX, U64_MAX);
            const tl = await impersonate(core.timelock.target);
            await pair.connect(tl).setRateContract(flat.target);
            await fund(weth, lenderA, pair, weth18("2"));
            await pair.connect(lenderA).deposit(weth18("2"), lenderA.address);
            await fund(usdc, borrower, pair, usdc6("4000"));
            await pair.connect(borrower).borrowAsset(weth18("1"), usdc6("4000"), borrower.address);
            let updates = 0;
            while ((await pair.totalAsset())[0] < U128_MAX) {
                await pair.addInterest(false);
                if (++updates > 40) throw new Error("ceiling not reached");
            }
            expect(await pair.interestRemainder()).to.equal(0n); // the capping accrual forfeited the remainder
            const before = await pair.currentRateInfo();
            const s = await step(pair, () => pair.addInterest(false));
            expect(s.interest).to.equal(0n); // S5a: zero headroom -> nothing accrues, no revert
            expect((s.dt * s.B * s.rate) % E18).to.not.equal(0n); // a remainder existed and was dropped
            expect(await pair.interestRemainder()).to.equal(0n);
            expect((await pair.currentRateInfo()).lastTimestamp).to.be.gt(before.lastTimestamp);
        });
    });

    // =============================================================================================
    // ISO-07
    // =============================================================================================
    describe("ISO-07: globalPause really pauses or reverts", function () {
        async function fxTwoPairs() {
            const ctx = await build();
            const { core, pairConfig } = ctx;
            const Token = await ethers.getContractFactory("MockERC20");
            const asset2 = await Token.deploy("WETH2", "WETH2", 18);
            const coll2 = await Token.deploy("USDC2", "USDC2", 6);
            await asset2.mint(core.lightlendPairDeployer.target, weth18("1"));
            const pair2 = (await ethers.getContractFactory("LightlendPair")).attach(
                await setup.deployPair({ ...pairConfig, assetTokenAddress: asset2.target, collateralTokenAddress: coll2.target })
            );
            const cb = await impersonate(await core.lightlendPairDeployer.circuitBreakerAddress());
            return { ...ctx, pair2, cb };
        }

        /// A pair deployed directly by an EOA: its DEPLOYER_ADDRESS is not the LightlendPairDeployer.
        async function deployForeignPair() {
            const [deployerEoa, owner, circuitBreaker, timelock] = await ethers.getSigners();
            const rate = await (await ethers.getContractFactory("LinearInterestRate")).deploy("zero", 80000, 0, 0, 0);
            const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
            const config = abi.encode(
                ["address", "address", "address", "uint32", "address", "uint64", "uint256", "uint256", "uint256"],
                [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, oracle.target, 5000, rate.target, 9500000000n, 75000n, 10000n, 1000n]
            );
            const immutables = abi.encode(["address", "address", "address"], [circuitBreaker.address, owner.address, timelock.address]);
            const custom = abi.encode(["string", "string", "uint8"], ["Foreign", "F", 18]);
            const foreign = await (await ethers.getContractFactory("LightlendPair")).deploy(config, immutables, custom);
            expect(await foreign.DEPLOYER_ADDRESS()).to.equal(deployerEoa.address);
            return foreign;
        }

        async function expectPaused(pair) {
            expect(await pair.isWithdrawPaused()).to.equal(true);
            expect(await pair.borrowLimit()).to.equal(0n);
            expect(await pair.depositLimit()).to.equal(0n);
            expect(await pair.isInterestPaused()).to.equal(true);
            // pause() semantics: repay and liquidation stay open
            expect(await pair.isRepayPaused()).to.equal(false);
            expect(await pair.isLiquidatePaused()).to.equal(false);
        }

        async function expectNotPaused(pair) {
            expect(await pair.isWithdrawPaused()).to.equal(false);
            expect(await pair.borrowLimit()).to.equal(ethers.MaxUint256);
            expect(await pair.depositLimit()).to.equal(ethers.MaxUint256);
            expect(await pair.isInterestPaused()).to.equal(false);
        }

        it("PoC-A port: globalPause([pair, pair2]) pauses every listed pair", async function () {
            const { core, pair, pair2, cb } = await loadFixture(fxTwoPairs);
            const deployer = core.lightlendPairDeployer;
            // who may call it is unchanged: the deployer's circuit breaker only
            expect(await deployer.circuitBreakerAddress()).to.equal(cb.address);
            await expect(deployer.connect(core.deployer).globalPause([pair.target])).to.be.revertedWithCustomError(
                deployer,
                "CircuitBreakerOnly"
            );
            const res = await deployer.connect(cb).globalPause.staticCall([pair.target, pair2.target]);
            await deployer.connect(cb).globalPause([pair.target, pair2.target]);
            console.log("      globalPause returned:", res, "isWithdrawPaused:", await pair.isWithdrawPaused());
            expect(res).to.deep.equal([pair.target, pair2.target]);
            await expectPaused(pair);
            await expectPaused(pair2);
        });

        it("a pair whose pause() fails makes globalPause revert, and nothing is paused", async function () {
            const { core, pair, pair2, cb } = await loadFixture(fxTwoPairs);
            const deployer = core.lightlendPairDeployer;
            const foreign = await deployForeignPair();
            await expect(deployer.connect(cb).globalPause([pair.target, foreign.target, pair2.target])).to.be.revertedWithCustomError(
                foreign,
                "OnlyProtocolOrOwner"
            );
            // an address that is not a pair (no code) reverts too
            await expect(deployer.connect(cb).globalPause([pair.target, ethers.Wallet.createRandom().address])).to.be.reverted;
            await expectNotPaused(pair);
            await expectNotPaused(pair2);
            await expectNotPaused(foreign);
        });

        it("the pair's deployer may call pause() and nothing else: no unpause, no setter", async function () {
            const { core, pair } = await loadFixture(fxTwoPairs);
            expect(await pair.DEPLOYER_ADDRESS()).to.equal(core.lightlendPairDeployer.target);
            const dep = await impersonate(core.lightlendPairDeployer.target);
            const asDeployer = pair.connect(dep);

            await asDeployer.pause();
            await expectPaused(pair);

            const aclSelectors = ["OnlyProtocolOrOwner", "OnlyTimelockOrOwner", "OnlyTimelock", "OnlyPendingTimelock"].map(
                (n) => pair.interface.getError(n).selector
            );
            // every state-changing function except user actions, pause() and the pre-existing setSwapper hook
            const userActions = new Set([
                "deposit", "mint", "redeem", "withdraw", "borrowAsset", "addCollateral", "removeCollateral", "repayAsset",
                "liquidate", "leveragedPosition", "repayAssetWithCollateral", "addInterest", "updateExchangeRate",
                "approve", "transfer", "transferFrom", "increaseAllowance", "decreaseAllowance",
            ]);
            const allowed = new Set(["pause", "setSwapper"]);
            const adminFns = pair.interface.fragments.filter(
                (f) => f.type === "function" && !f.constant && !userActions.has(f.name) && !allowed.has(f.name)
            );
            const names = adminFns.map((f) => f.name);
            expect(names).to.include.members(["unpause", "setBorrowLimit", "setDepositLimit", "setMaxLTV", "setLiquidationFees",
                "setOracle", "setRateContract", "changeFee", "setCircuitBreaker", "withdrawFees", "pauseInterest", "transferOwnership"]);
            const argFor = (t) => (t === "address" ? ethers.Wallet.createRandom().address : t === "bool" ? true : t.startsWith("uint") ? 1n : "0x");
            let checked = 0;
            for (const f of adminFns) {
                const variants = f.inputs.some((i) => i.type === "bool")
                    ? [true, false].map((b) => f.inputs.map((i) => (i.type === "bool" ? b : argFor(i.type))))
                    : [f.inputs.map((i) => argFor(i.type))];
                for (const args of variants) {
                    let data = null;
                    try {
                        await asDeployer[f.format()].staticCall(...args);
                    } catch (e) {
                        // a revert: decoded data, or Hardhat's message for empty revert data
                        const empty = /Transaction reverted (without a reason|and Hardhat couldn't infer the reason)/.test(e.message);
                        expect(e.data !== undefined || empty, `${f.format()}: ${e.message}`).to.equal(true);
                        data = e.data ?? "0x";
                    }
                    expect(data, `${f.format()}(${args}) must revert for the deployer`).to.not.equal(null);
                    // an access-control error, or empty data (Ownable's stripped require strings)
                    const ok = data === "0x" || aclSelectors.includes(data.slice(0, 10));
                    expect(ok, `${f.format()} reverted for a reason other than access control: ${data}`).to.equal(true);
                    await expect(asDeployer[f.format()](...args)).to.be.reverted;
                    checked++;
                }
            }
            console.log(`      ${checked} admin calls from DEPLOYER_ADDRESS all reverted on access control`);
            await expectPaused(pair); // still paused: the deployer could not undo it

            // Pre-existing, unchanged: setSwapper accepts the deployer until the owner revokes it. The deployer
            // contract only uses it in _deploy() for the owner-set default swappers (none on Lighter).
            const swapper = ethers.Wallet.createRandom().address;
            const owner = await impersonate(await pair.owner());
            await pair.connect(owner).revokeDeployerSwapperAccess();
            await expect(asDeployer.setSwapper(swapper, true)).to.be.reverted;
            expect(await pair.swappers(swapper)).to.equal(false);
        });
    });

    // =============================================================================================
    // Leverage paths
    // =============================================================================================
    describe("leverage paths without a whitelisted swapper", function () {
        it("leveragedPosition and repayAssetWithCollateral revert (BadSwapper)", async function () {
            const ctx = await build();
            const { core, pair, usdc, weth, lenderA, borrower } = ctx;
            // the deployer has no default swappers, so the pair has none whitelisted
            await expect(core.lightlendPairDeployer.defaultSwappers(0)).to.be.reverted;
            await fund(weth, lenderA, pair, weth18("10"));
            await pair.connect(lenderA).deposit(weth18("10"), lenderA.address);
            await fund(usdc, borrower, pair, usdc6("10000"));
            await pair.connect(borrower).borrowAsset(weth18("1"), usdc6("5000"), borrower.address);
            const shares0 = await pair.userBorrowShares(borrower.address);
            const coll0 = await pair.userCollateralBalance(borrower.address);

            const MockToken = await ethers.getContractFactory("MockERC20");
            const anyContract = await MockToken.deploy("X", "X", 18);
            const candidates = [ethers.ZeroAddress, ethers.Wallet.createRandom().address, anyContract.target, core.lightlendPairDeployer.target];
            for (const swapper of candidates) {
                expect(await pair.swappers(swapper)).to.equal(false);
                await expect(
                    pair.connect(borrower).leveragedPosition(swapper, weth18("0.1"), usdc6("1000"), 0, [weth.target, usdc.target])
                ).to.be.revertedWithCustomError(pair, "BadSwapper");
                await expect(
                    pair.connect(borrower).repayAssetWithCollateral(swapper, usdc6("100"), 0, [usdc.target, weth.target])
                ).to.be.revertedWithCustomError(pair, "BadSwapper");
            }
            expect(await pair.userBorrowShares(borrower.address)).to.equal(shares0);
            expect(await pair.userCollateralBalance(borrower.address)).to.equal(coll0);
        });
    });
});
