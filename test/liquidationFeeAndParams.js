const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const setup = require("./utils/setup");

/**
 * S5a: liquidation fee and parameter validation.
 * - ISO-01: the protocol liquidation fee is a share of the liquidation bonus only, and validation
 *   requires the liquidator to keep a net bonus of at least 2% (clean and dirty path).
 * - ISO-05: validation requires maxLTV * (1 + cleanLiquidationFee) <= 98%.
 * - ISO-04: rate-contract constructors reject parameters that can make getNewRate() revert, which
 *   would brick the pair's _addInterest() (and with it pause(), repay and liquidate).
 * Ports PoC-D (ISO-01), PoC-E (ISO-05) and PoC-F (ISO-04) from the review.
 */

const abi = ethers.AbiCoder.defaultAbiCoder();
const U64_MAX = 2n ** 64n - 1n;
const E18 = 10n ** 18n;
const usdc6 = (x) => ethers.parseUnits(x, 6);
const weth18 = (x) => ethers.parseUnits(x, 18);

// Review PoC rate curve (same as the existing suites).
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

function rateArgs(cfg) {
    return [
        cfg.suffix,
        cfg.vertexUtilization,
        cfg.vertexRatePercentOfDelta,
        cfg.minUtil,
        cfg.maxUtil,
        cfg.zeroUtilizationRate,
        cfg.minFullUtilizationRate,
        cfg.maxFullUtilizationRate,
        cfg.rateHalfLife,
    ];
}

async function impersonate(addr) {
    await network.provider.send("hardhat_impersonateAccount", [addr]);
    await network.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]);
    return ethers.getSigner(addr);
}

async function fund(token, who, pair, amount) {
    await token.mint(who.address, amount);
    await token.connect(who).approve(pair.target, ethers.MaxUint256);
}

/// Full deploy through LightlendPairDeployer: asset WETH (18 dec), collateral USDC (6 dec), WETH = $2400.
/// `rate: "zero"` uses a LinearInterestRate with all rates 0 so liquidation amounts are deterministic.
async function build({
    maxLTV = "75000",
    cleanLiquidationFee = "10000",
    protocolLiquidationFee = "1000",
    rate = {},
    wethUsd = 2400n,
}) {
    const core = await setup.deployCore();
    let interestRate;
    if (rate === "zero") {
        interestRate = await (await ethers.getContractFactory("LinearInterestRate")).deploy("zero", 80000, 0, 0, 0);
    } else {
        ({ interestRate } = await setup.deployInterestRate({ ...POC_RATE, ...rate }));
    }
    const { mockTokens } = await setup.deployMockTokens(["USDC", "WETH"], [6, 18]);
    const usdc = mockTokens.USDC;
    const weth = mockTokens.WETH;
    const wethFeed = await setup.deployMockChainlinkOracle((wethUsd * 10n ** 8n).toString());
    const usdcFeed = await setup.deployMockChainlinkOracle((10n ** 8n).toString());
    const { oracle } = await setup.deployOracle({
        baseToken: weth.target,
        quoteToken: usdc.target,
        chainlinkMultiplyAddress: wethFeed.target,
        chainlinkDivideAddress: usdcFeed.target,
        maxOracleDelay: "1000000",
        timelockAddress: core.timelock.target,
        name: "s5a",
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
    const pairAddress = await setup.deployPair(pairConfig);
    const pair = (await ethers.getContractFactory("LightlendPair")).attach(pairAddress);
    const signers = await ethers.getSigners();
    return { core, pair, usdc, weth, wethFeed, usdcFeed, oracle, interestRate, signers, pairConfig };
}

function encodeConfig({ rateContract, oracle, maxLTV, cleanLiquidationFee, protocolLiquidationFee }) {
    return abi.encode(
        ["address", "address", "address", "uint32", "address", "uint64", "uint256", "uint256", "uint256"],
        [
            ethers.Wallet.createRandom().address,
            ethers.Wallet.createRandom().address,
            oracle,
            5000,
            rateContract,
            9500000000n,
            maxLTV,
            cleanLiquidationFee,
            protocolLiquidationFee,
        ]
    );
}

/// Deploys the pair contract directly (no deployer/seed) with a zero-rate curve and a static mock oracle.
/// The 4th hardhat signer is the pair's timelock, so setters can be called without impersonation.
async function directPairFactory() {
    const [, owner, circuitBreaker, timelock] = await ethers.getSigners();
    const rate = await (await ethers.getContractFactory("LinearInterestRate")).deploy("zero", 80000, 0, 0, 0);
    const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    const Pair = await ethers.getContractFactory("LightlendPair");
    const immutables = abi.encode(
        ["address", "address", "address"],
        [circuitBreaker.address, owner.address, timelock.address]
    );
    const custom = abi.encode(["string", "string", "uint8"], ["S5a Pair", "S5A", 18]);
    const deployDirect = ({ maxLTV, cleanLiquidationFee, protocolLiquidationFee = 1000n }) =>
        Pair.deploy(
            encodeConfig({
                rateContract: rate.target,
                oracle: oracle.target,
                maxLTV,
                cleanLiquidationFee,
                protocolLiquidationFee,
            }),
            immutables,
            custom
        );
    return { Pair, deployDirect, timelock };
}

/// Two-step rejection check. The first, generic assertion fails with "Expected transaction to be
/// reverted" when the call succeeds (which is what the pre-fix code does); the second, identical call
/// then pins the specific custom error on the fixed code.
async function expectRejected(send, contract, errorName) {
    await expect(send()).to.be.reverted;
    await expect(send()).to.be.revertedWithCustomError(contract, errorName);
}

/// Sends LightlendPairDeployer.deploy() for a fresh asset/collateral pair (unique registry name), so the
/// only possible failure is the pair constructor. A constructor revert surfaces as Create2Failed.
let freshTokenNonce = 0;
async function deployViaDeployer(ctx, overrides) {
    freshTokenNonce++;
    const Token = await ethers.getContractFactory("MockERC20");
    const asset = await Token.deploy(`WETH${freshTokenNonce}`, `WETH${freshTokenNonce}`, 18);
    const collateral = await Token.deploy(`USDC${freshTokenNonce}`, `USDC${freshTokenNonce}`, 6);
    await asset.mint(ctx.core.lightlendPairDeployer.target, weth18("1"));
    const c = { ...ctx.pairConfig, ...overrides };
    const configData = abi.encode(
        ["address", "address", "address", "uint32", "address", "uint64", "uint256", "uint256", "uint256"],
        [
            asset.target,
            collateral.target,
            c.oracleAddress,
            c.maxOracleDeviation,
            c.interestRateAddress,
            c.fullUtilizationRate,
            c.maxLTV,
            c.cleanLiquidationFee,
            c.protocolLiquidationFee,
        ]
    );
    return ctx.core.lightlendPairDeployer.deploy(configData);
}

/// Calls getNewRate over a grid of utilizations, elapsed times and stored full-utilization rates.
/// Any revert fails the test (ISO-04: the rate must never brick the pair's _addInterest()).
async function expectRateNeverReverts(rate, extraUtils = []) {
    const utils = [0n, 1n, 49_999n, 50_000n, 75_000n, 85_000n, 85_001n, 89_999n, 90_000n, 99_999n, 100_000n, ...extraUtils];
    const dts = [0n, 1n, 86_400n, 2n ** 32n, U64_MAX];
    const fulls = [0n, 1n, 3_189_000_000n, 31_890_000_000n, U64_MAX];
    const calls = [];
    for (const u of utils) for (const dt of dts) for (const f of fulls) calls.push(rate.getNewRate(dt, u, f));
    const results = await Promise.all(calls);
    expect(results.length).to.equal(utils.length * dts.length * fulls.length);
}

// -------------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------------

const fxProtoFee10 = () => build({ protocolLiquidationFee: "10000" }); // deploy-lighter.js protocol fee value

/// Spec §3.1 parameters (maxLTV 75%, clean 5%, protocol = 10% of the bonus) on a zero-interest pair.
/// Lender deposits 10 WETH; borrower posts 3000 USDC and borrows 0.9 WETH (LTV 72% at $2400).
async function fxSpecPosition() {
    const ctx = await build({ maxLTV: "75000", cleanLiquidationFee: "5000", protocolLiquidationFee: "10000", rate: "zero" });
    const { pair, usdc, weth, signers } = ctx;
    const [, , , , lender, , borrower, liquidator] = signers;
    await fund(weth, lender, pair, weth18("10"));
    await pair.connect(lender).deposit(weth18("10"), lender.address);
    await fund(usdc, borrower, pair, usdc6("3000"));
    await pair.connect(borrower).borrowAsset(weth18("0.9"), usdc6("3000"), borrower.address);
    await fund(weth, liquidator, pair, weth18("1"));
    return { ...ctx, lender, borrower, liquidator };
}

async function liquidateAndMeasure(ctx, wethPrice, shares) {
    const { pair, usdc, weth, wethFeed, borrower, liquidator } = ctx;
    await wethFeed.setAnswer((BigInt(wethPrice) * 10n ** 8n).toString());
    await time.increase(10);
    await pair.updateExchangeRate();
    const exchangeRate = (await pair.exchangeRateInfo())[4]; // low rate, used by liquidate()
    const usdc0 = await usdc.balanceOf(liquidator.address);
    const weth0 = await weth.balanceOf(liquidator.address);
    const tx = await pair.connect(liquidator).liquidate(shares, (await time.latest()) + 3600, borrower.address);
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => pair.interface.parseLog(l)).find((l) => l && l.name === "Liquidate");
    return {
        exchangeRate,
        liquidatorUsdc: (await usdc.balanceOf(liquidator.address)) - usdc0,
        liquidatorWethPaid: weth0 - (await weth.balanceOf(liquidator.address)),
        feesEvent: ev.args._feesAmount,
        collateralEvent: ev.args._collateralForLiquidator,
        protocolCollateral: await pair.userCollateralBalance(pair.target),
        borrowerCollateral: await pair.userCollateralBalance(borrower.address),
        borrowerShares: await pair.userBorrowShares(borrower.address),
        writeOff: await pair.cumulativeBadDebtWriteOff(),
    };
}

describe("S5a: liquidation fee and parameter validation", function () {
    // =============================================================================================
    // ISO-01
    // =============================================================================================
    describe("ISO-01: protocol fee is a share of the bonus; liquidator keeps >= 2%", function () {
        it("PoC-D port: with a 10% protocol fee a dirty liquidation pays the liquidator more than it repays", async function () {
            const { pair, usdc, weth, wethFeed, signers } = await loadFixture(fxProtoFee10);
            const [, , , , A, , borrower, liq] = signers;
            await fund(weth, A, pair, weth18("2"));
            await pair.connect(A).deposit(weth18("2"), A.address);
            await fund(usdc, borrower, pair, usdc6("4000"));
            await pair.connect(borrower).borrowAsset(weth18("1.2"), usdc6("4000"), borrower.address);
            await wethFeed.setAnswer((2600n * 10n ** 8n).toString()); // LTV 78% -> liquidatable
            await time.increase(10);
            await fund(weth, liq, pair, weth18("2"));
            const shares = (await pair.userBorrowShares(borrower.address)) / 2n;
            const w0 = await weth.balanceOf(liq.address);
            await pair.connect(liq).liquidate(shares, (await time.latest()) + 3600, borrower.address);
            const paidWeth = w0 - (await weth.balanceOf(liq.address));
            const gotUsdc = await usdc.balanceOf(liq.address);
            const paidUsd = (paidWeth * 2600n) / 10n ** 12n; // 6-dec USD
            // dirty fee 9%, protocol takes 10% of it -> liquidator nets ~8.1%; the old code returned 0.981x
            expect(gotUsdc).to.be.gt(paidUsd);
            expect(gotUsdc).to.be.gte((paidUsd * 108_090n) / 100_000n);
            expect(gotUsdc).to.be.lte((paidUsd * 108_110n) / 100_000n);
        });

        it("dirty liquidation, spec params: exact amounts, fee = 10% of the 4.5% bonus", async function () {
            const ctx = await loadFixture(fxSpecPosition);
            const r = await liquidateAndMeasure(ctx, 2600, weth18("0.3"));
            expect(r.exchangeRate).to.equal(2_600_000_000n); // 2600 USDC (6 dec) per 1e18 WETH
            // debt repaid in collateral units L = 0.3 * 2600 = 780 USDC; gross = L * 1.045 = 815.1 USDC
            // bonus = 35.1 USDC; protocol fee = 10% of bonus = 3.51 USDC; liquidator gets 811.59 USDC
            expect(r.liquidatorWethPaid).to.equal(weth18("0.3"));
            expect(r.feesEvent).to.equal(3_510_000n);
            expect(r.collateralEvent).to.equal(811_590_000n);
            expect(r.liquidatorUsdc).to.equal(811_590_000n);
            expect(r.protocolCollateral).to.equal(3_510_000n);
            expect(r.borrowerCollateral).to.equal(usdc6("3000") - 815_100_000n);
            expect(r.borrowerShares).to.equal(weth18("0.6"));
            expect(r.writeOff).to.equal(0n);
        });

        it("clean liquidation with write-off: exact amounts, fee = 10% of the collateral seized beyond L", async function () {
            const ctx = await loadFixture(fxSpecPosition);
            // At $3500: L = 0.82 * 3500 = 2870 USDC; L * 1.05 = 3013.5 > 3000 -> clean path, all collateral
            // seized. Bonus = 3000 - 2870 = 130 USDC; fee = 13 USDC; liquidator gets 2987 USDC.
            // The remaining 0.08 WETH of debt is written off.
            const r = await liquidateAndMeasure(ctx, 3500, weth18("0.82"));
            expect(r.exchangeRate).to.equal(3_500_000_000n);
            expect(r.liquidatorWethPaid).to.equal(weth18("0.82"));
            expect(r.feesEvent).to.equal(13_000_000n);
            expect(r.liquidatorUsdc).to.equal(2_987_000_000n);
            expect(r.protocolCollateral).to.equal(13_000_000n);
            expect(r.borrowerCollateral).to.equal(0n);
            expect(r.borrowerShares).to.equal(0n);
            expect(r.writeOff).to.equal(weth18("0.08"));
        });

        it("underwater clean liquidation: no bonus, so no protocol fee", async function () {
            const ctx = await loadFixture(fxSpecPosition);
            // At $3500: L = 0.9 * 3500 = 3150 USDC > 3000 USDC collateral -> bonus 0 -> fee 0
            const r = await liquidateAndMeasure(ctx, 3500, weth18("0.9"));
            expect(r.liquidatorWethPaid).to.equal(weth18("0.9"));
            expect(r.feesEvent).to.equal(0n);
            expect(r.liquidatorUsdc).to.equal(usdc6("3000"));
            expect(r.protocolCollateral).to.equal(0n);
            expect(r.borrowerCollateral).to.equal(0n);
            expect(r.borrowerShares).to.equal(0n);
        });

        it("constructor: net bonus exactly 2% is allowed, just below is rejected", async function () {
            const { Pair, deployDirect } = await directPairFactory();
            // clean 2.778% -> dirty = floor(2778 * 0.9) = 2500; 2500 * (1e5 - 20000) = 2% * 1e5^2 exactly
            const ok = await deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 2778n, protocolLiquidationFee: 20000n });
            expect(await ok.dirtyLiquidationFee()).to.equal(2500n);
            expect(await ok.protocolLiquidationFee()).to.equal(20000n);
            await expectRejected(
                () => deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 2778n, protocolLiquidationFee: 20001n }),
                Pair,
                "InsufficientLiquidatorBonus"
            );
            // clean 2.777% -> dirty 2499 -> 1.9992% net
            await expectRejected(
                () => deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 2777n, protocolLiquidationFee: 20000n }),
                Pair,
                "InsufficientLiquidatorBonus"
            );
            // no protocol fee: clean 2.223% -> dirty 2000 = 2% allowed; 2.222% -> dirty 1999 rejected
            await deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 2223n, protocolLiquidationFee: 0n });
            await expectRejected(
                () => deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 2222n, protocolLiquidationFee: 0n }),
                Pair,
                "InsufficientLiquidatorBonus"
            );
        });

        it("setLiquidationFees: both clean and dirty net bonus must be >= 2%", async function () {
            const { Pair, deployDirect, timelock } = await directPairFactory();
            const pair = await deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 10000n });
            await pair.connect(timelock).setLiquidationFees(2500n, 2500n, 20000n); // exactly 2% on both paths
            expect(await pair.protocolLiquidationFee()).to.equal(20000n);
            const set = (c, d, p) => () => pair.connect(timelock).setLiquidationFees(c, d, p);
            await expectRejected(set(2500n, 2500n, 20001n), Pair, "InsufficientLiquidatorBonus");
            await expectRejected(set(2500n, 2499n, 20000n), Pair, "InsufficientLiquidatorBonus"); // dirty binds
            await expectRejected(set(2499n, 2499n, 20000n), Pair, "InsufficientLiquidatorBonus"); // both 1.9992%
            expect(await pair.protocolLiquidationFee()).to.equal(20000n);
        });

        it("deployer path: spec params deploy; a config with a < 2% net bonus cannot be deployed", async function () {
            const ctx = await build({
                maxLTV: "75000",
                cleanLiquidationFee: "5000",
                protocolLiquidationFee: "10000",
                rate: "zero",
            });
            expect(await ctx.pair.cleanLiquidationFee()).to.equal(5000n);
            expect(await ctx.pair.dirtyLiquidationFee()).to.equal(4500n);
            expect(await ctx.pair.protocolLiquidationFee()).to.equal(10000n);
            // clean 2% -> dirty 1.8%, protocol 10% of the bonus -> dirty net 1.62% < 2%
            await expectRejected(
                () => deployViaDeployer(ctx, { cleanLiquidationFee: "2000", protocolLiquidationFee: "10000" }),
                ctx.core.lightlendPairDeployer,
                "Create2Failed"
            );
            // the same deployer still deploys a valid config (fresh tokens)
            await deployViaDeployer(ctx, { cleanLiquidationFee: "5000", protocolLiquidationFee: "10000" });
        });
    });

    // =============================================================================================
    // ISO-05
    // =============================================================================================
    describe("ISO-05: maxLTV * (1 + cleanLiquidationFee) <= 98%", function () {
        it("PoC-E port: 95% maxLTV with a 10% clean fee is rejected; at the bound a +2% tick self-liquidation loses money", async function () {
            // (a) the PoC-E config can no longer be deployed (95% * 1.1 = 104.5%)
            const { Pair, deployDirect } = await directPairFactory();
            await expectRejected(
                () => deployDirect({ maxLTV: 95000n, cleanLiquidationFee: 10000n }),
                Pair,
                "MaxLTVTooHighForLiquidationFee"
            );
            const base = await build({ maxLTV: "75000", rate: "zero" });
            await expectRejected(
                () => deployViaDeployer(base, { maxLTV: "95000", cleanLiquidationFee: "10000" }),
                base.core.lightlendPairDeployer,
                "Create2Failed"
            );

            // (b) Zero interest, exactly at both bounds: maxLTV 87.5% with a 12% clean fee is
            // 87.5% * 1.12 = 98%, and the borrow below is exactly at maxLTV. WETH $2500.
            const { pair, usdc, weth, wethFeed, signers } = await build({
                maxLTV: "87500",
                cleanLiquidationFee: "12000", // dirty = 10.8%
                protocolLiquidationFee: "1000", // 1% of the bonus
                rate: "zero",
                wethUsd: 2500n,
            });
            const [, , , , A, , attacker, attacker2] = signers;
            await fund(weth, A, pair, weth18("10"));
            await pair.connect(A).deposit(weth18("10"), A.address);
            await fund(usdc, attacker, pair, usdc6("10000"));
            // 3.5 WETH * $2500 / 10,000 USDC = 87.5% = maxLTV exactly (allowed)
            await pair.connect(attacker).borrowAsset(weth18("3.5"), usdc6("10000"), attacker2.address);
            await pair.updateExchangeRate();
            const rate0 = (await pair.exchangeRateInfo())[5];
            expect(rate0).to.equal(2_500_000_000n);
            expect((((weth18("3.5") * rate0) / E18) * 100_000n) / usdc6("10000")).to.equal(87_500n);
            // +2% tick to $2550: LTV 89.25%. A clean liquidation needs repaid * 1.12 >= collateral,
            // i.e. LTV >= 89.29%, so even repaying all debt stays on the dirty path.
            await wethFeed.setAnswer((2550n * 10n ** 8n).toString());
            await time.increase(10);
            await weth.connect(attacker2).approve(pair.target, ethers.MaxUint256);
            const shares = await pair.userBorrowShares(attacker.address);
            expect(shares).to.equal(weth18("3.5"));
            await pair.connect(attacker2).liquidate(shares, (await time.latest()) + 3600, attacker.address);
            // L = 3.5 * 2550 = 8925 USDC; L * 1.12 = 9996 < 10000 -> dirty: gross = L * 1.108 = 9888.9 USDC
            // bonus = 963.9; protocol fee = 1% of bonus = 9.639; liquidator gets 9879.261; 111.1 USDC remains.
            // A (wrong) clean branch would have sent all 10,000 USDC minus fee and left 0.
            expect(await usdc.balanceOf(attacker2.address)).to.equal(9_879_261_000n);
            expect(await pair.userCollateralBalance(pair.target)).to.equal(9_639_000n);
            expect(await pair.userCollateralBalance(attacker.address)).to.equal(111_100_000n);
            expect(await weth.balanceOf(attacker2.address)).to.equal(0n); // repaid exactly 3.5 WETH
            expect(await pair.userBorrowShares(attacker.address)).to.equal(0n);
            expect(await pair.cumulativeBadDebtWriteOff()).to.equal(0n);
            await pair.connect(attacker).removeCollateral(111_100_000n, attacker.address);
            const usdcEnd = (await usdc.balanceOf(attacker.address)) + (await usdc.balanceOf(attacker2.address));
            // Attacker ends with 9990.361 USDC and no WETH: it lost exactly the protocol fee.
            expect(usdcEnd).to.equal(9_990_361_000n);
            expect(usdcEnd).to.be.lt(usdc6("10000"));
        });

        it("constructor: maxLTV * (1 + clean fee) exactly 98% is allowed, just past is rejected", async function () {
            const { Pair, deployDirect } = await directPairFactory();
            // 87.5% * 1.12 = 98% exactly
            const ok = await deployDirect({ maxLTV: 87500n, cleanLiquidationFee: 12000n });
            expect(await ok.maxLTV()).to.equal(87500n);
            const E = "MaxLTVTooHighForLiquidationFee";
            await expectRejected(() => deployDirect({ maxLTV: 87501n, cleanLiquidationFee: 12000n }), Pair, E);
            await expectRejected(() => deployDirect({ maxLTV: 87500n, cleanLiquidationFee: 12001n }), Pair, E);
            // 70% * 1.4 = 98% exactly
            await deployDirect({ maxLTV: 70000n, cleanLiquidationFee: 40000n });
            await expectRejected(() => deployDirect({ maxLTV: 70001n, cleanLiquidationFee: 40000n }), Pair, E);
        });

        it("setMaxLTV: checked against the current clean fee", async function () {
            const { Pair, deployDirect, timelock } = await directPairFactory();
            const pair = await deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 12000n });
            await pair.connect(timelock).setMaxLTV(87500n);
            expect(await pair.maxLTV()).to.equal(87500n);
            const E = "MaxLTVTooHighForLiquidationFee";
            await expectRejected(() => pair.connect(timelock).setMaxLTV(87501n), Pair, E);
            await expectRejected(() => pair.connect(timelock).setMaxLTV(100000n), Pair, E);
            expect(await pair.maxLTV()).to.equal(87500n);
        });

        it("setLiquidationFees: the new clean fee is checked against the current maxLTV", async function () {
            const { Pair, deployDirect, timelock } = await directPairFactory();
            const pair = await deployDirect({ maxLTV: 87500n, cleanLiquidationFee: 10000n });
            await pair.connect(timelock).setLiquidationFees(12000n, 10800n, 1000n);
            expect(await pair.cleanLiquidationFee()).to.equal(12000n);
            await expectRejected(
                () => pair.connect(timelock).setLiquidationFees(12001n, 10800n, 1000n),
                Pair,
                "MaxLTVTooHighForLiquidationFee"
            );
            expect(await pair.cleanLiquidationFee()).to.equal(12000n);
        });
    });

    // =============================================================================================
    // ISO-04
    // =============================================================================================
    describe("ISO-04: rate contracts reject parameters that can brick the pair", function () {
        it("PoC-F port: vertexUtilization = 100% is rejected; 99.999% is accepted and never reverts", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            await expect(VIR.deploy(...rateArgs({ ...POC_RATE, vertexUtilization: "100000" }))).to.be.reverted;
            const ok = await VIR.deploy(...rateArgs({ ...POC_RATE, vertexUtilization: "99999" }));
            expect(await ok.VERTEX_UTILIZATION()).to.equal(99_999n);
            await expectRateNeverReverts(ok);
            // pair-level liveness at exactly 100% utilization: see "G" tests below
        });

        it("vertexRatePercentOfDelta: 1e18 allowed, 1e18 + 1 (and PoC-F's 2e18) rejected", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const ok = await VIR.deploy(...rateArgs({ ...POC_RATE, vertexRatePercentOfDelta: E18.toString() }));
            await expectRateNeverReverts(ok);
            await expect(VIR.deploy(...rateArgs({ ...POC_RATE, vertexRatePercentOfDelta: (E18 + 1n).toString() }))).to.be
                .reverted;
            await expect(VIR.deploy("x", 80000, 2n * E18, 50000, 75000, 0, 3189000000n, 31890000000n, 86400)).to.be.reverted;
        });

        it("maxUtil (MAX_TARGET_UTIL): 99.999% allowed, 100% rejected", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const ok = await VIR.deploy(...rateArgs({ ...POC_RATE, maxUtil: "99999" }));
            await expectRateNeverReverts(ok);
            await expect(VIR.deploy(...rateArgs({ ...POC_RATE, maxUtil: "100000" }))).to.be.reverted;
        });

        it("maxFullUtilizationRate: uint64 max allowed, uint64 max + 1 rejected", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const ok = await VIR.deploy(
                ...rateArgs({ ...POC_RATE, minFullUtilizationRate: U64_MAX.toString(), maxFullUtilizationRate: U64_MAX.toString() })
            );
            await expectRateNeverReverts(ok);
            const [r, f] = await ok.getNewRate(1n, 100_000n, 1n);
            expect(f).to.equal(U64_MAX);
            expect(r).to.equal(U64_MAX);
            await expect(
                VIR.deploy(...rateArgs({ ...POC_RATE, maxFullUtilizationRate: (U64_MAX + 1n).toString() }))
            ).to.be.reverted;
            // With min = max = 2^64 the old code accepted the curve and getNewRate underflowed on every call.
            await expect(
                VIR.deploy(
                    ...rateArgs({
                        ...POC_RATE,
                        minFullUtilizationRate: (U64_MAX + 1n).toString(),
                        maxFullUtilizationRate: (U64_MAX + 1n).toString(),
                    })
                )
            ).to.be.reverted;
        });

        it("rateHalfLife: uint64 max allowed, uint64 max + 1 and overflowing values rejected", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const ok = await VIR.deploy(...rateArgs({ ...POC_RATE, rateHalfLife: U64_MAX.toString() }));
            await expectRateNeverReverts(ok);
            await expect(VIR.deploy(...rateArgs({ ...POC_RATE, rateHalfLife: (U64_MAX + 1n).toString() }))).to.be.reverted;
            // 2^130 overflowed _fullUtilizationInterest * RATE_HALF_LIFE * 1e36 below min util
            await expect(VIR.deploy(...rateArgs({ ...POC_RATE, rateHalfLife: (2n ** 130n).toString() }))).to.be.reverted;
        });

        it("drops the mixed-unit zero-rate vs vertex-percent check: zero rate > vertexRatePercentOfDelta is valid", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const ok = await VIR.deploy(...rateArgs({ ...POC_RATE, vertexRatePercentOfDelta: "0" }));
            await expectRateNeverReverts(ok);
            // VRP = 0: the vertex rate equals the zero-utilization rate
            const [r] = await ok.getNewRate(1n, 90_000n, 3_189_000_000n);
            expect(r).to.equal(318_900_000n);
        });

        it("LinearInterestRate: full rate uint64 max allowed, uint64 max + 1 rejected", async function () {
            const LIR = await ethers.getContractFactory("LinearInterestRate");
            const ok = await LIR.deploy("edge", 99_999, 0, 0, U64_MAX);
            await expectRateNeverReverts(ok, [100_001n]);
            const [r, f] = await ok.getNewRate(0n, 100_000n, 0n);
            expect(r).to.equal(U64_MAX);
            expect(f).to.equal(U64_MAX);
            await expect(LIR.deploy("bad", 80000, 0, 0, U64_MAX + 1n)).to.be.reverted;
        });
    });
});

// =================================================================================================
// Round 1 (Codex review of 71cd1aa): A dirty <= clean, B rate clamp before cast, C no revert at the
// uint128 ceiling, F exact amounts with accrued interest in both decimal directions, G liveness at
// exactly 100% utilization. (D is NatSpec only; E rebuilt the PoC-E test above.)
// =================================================================================================

const U128_MAX = 2n ** 128n - 1n;
const LIQ = 100_000n;
const R10 = 3_170_979_198n; // flat ~10% APR per second, 1e18 precision
const YEAR = 31_536_000;

function vaToAmount(t, shares, roundUp) {
    const A = t.amount + 1000n;
    const S = t.shares + 1000n;
    let a = (shares * A) / S;
    if (roundUp && (a * S) / A < shares) a += 1n;
    return a;
}

function vaToShares(t, amount, roundUp) {
    const A = t.amount + 1000n;
    const S = t.shares + 1000n;
    let s = (amount * S) / A;
    if (roundUp && (s * A) / S < amount) s += 1n;
    return s;
}

const va = (r) => ({ amount: r[0], shares: r[1] });

/// Market for exact liquidation math. asset "WETH": WETH (18) debt / USDC (6) collateral;
/// asset "USDC": USDC (6) debt / WETH (18) collateral. Spec fees, flat LinearInterestRate.
async function buildMarket({ asset, flatRate, maxLTV = "75000", cleanLiquidationFee = "5000", protocolLiquidationFee = "10000" }) {
    const core = await setup.deployCore();
    const interestRate = await (await ethers.getContractFactory("LinearInterestRate")).deploy(
        "flat",
        80000,
        flatRate,
        flatRate,
        flatRate
    );
    const { mockTokens } = await setup.deployMockTokens(["USDC", "WETH"], [6, 18]);
    const usdc = mockTokens.USDC;
    const weth = mockTokens.WETH;
    const wethFeed = await setup.deployMockChainlinkOracle((2400n * 10n ** 8n).toString());
    const usdcFeed = await setup.deployMockChainlinkOracle((10n ** 8n).toString());
    const assetToken = asset === "WETH" ? weth : usdc;
    const collateralToken = asset === "WETH" ? usdc : weth;
    const { oracle } = await setup.deployOracle({
        baseToken: assetToken.target,
        quoteToken: collateralToken.target,
        chainlinkMultiplyAddress: (asset === "WETH" ? wethFeed : usdcFeed).target,
        chainlinkDivideAddress: (asset === "WETH" ? usdcFeed : wethFeed).target,
        maxOracleDelay: "1000000",
        timelockAddress: core.timelock.target,
        name: "s5a-r1",
    });
    await assetToken.mint(core.lightlendPairDeployer.target, 10n ** 18n);
    const pairConfig = {
        lightlendPairRegistry: core.lightlendPairRegistry.target,
        lightlendPairDeployerAddress: core.lightlendPairDeployer.target,
        assetTokenAddress: assetToken.target,
        collateralTokenAddress: collateralToken.target,
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
    const [, , , , lender, , borrower, liquidator] = signers;
    return { core, pair, usdc, weth, wethFeed, usdcFeed, oracle, interestRate, assetToken, collateralToken, lender, borrower, liquidator, flatRate };
}

/// WETH debt / USDC collateral: 0.85 WETH borrowed against 3,000 USDC, then one year at ~10% accrued,
/// so the borrow share price is ~1.1 (shares != amounts).
async function fxWethDebtAccrued() {
    const m = await buildMarket({ asset: "WETH", flatRate: R10 });
    await fund(m.weth, m.lender, m.pair, weth18("10"));
    await m.pair.connect(m.lender).deposit(weth18("10"), m.lender.address);
    await fund(m.usdc, m.borrower, m.pair, usdc6("3000"));
    await m.pair.connect(m.borrower).borrowAsset(weth18("0.85"), usdc6("3000"), m.borrower.address);
    await fund(m.weth, m.liquidator, m.pair, weth18("10"));
    await time.increase(YEAR);
    await m.pair.addInterest(false);
    return m;
}

/// USDC debt / WETH collateral: 16,000 USDC borrowed against 10 WETH, then one year at ~10% accrued.
async function fxUsdcDebtAccrued() {
    const m = await buildMarket({ asset: "USDC", flatRate: R10 });
    await fund(m.usdc, m.lender, m.pair, usdc6("100000"));
    await m.pair.connect(m.lender).deposit(usdc6("100000"), m.lender.address);
    await fund(m.weth, m.borrower, m.pair, weth18("10"));
    await m.pair.connect(m.borrower).borrowAsset(usdc6("16000"), weth18("10"), m.borrower.address);
    await fund(m.usdc, m.liquidator, m.pair, usdc6("100000"));
    await time.increase(YEAR);
    await m.pair.addInterest(false);
    return m;
}

/// Liquidates and checks every amount against a BigInt model of LightlendPairCore.liquidate():
/// interest accrued in the liquidation block first (flat rate), debt value rounded down for the quote,
/// repayment rounded up, protocol fee (share of the bonus) rounded down, write-off per the existing cap.
async function liquidateExact(m, { wethUsd, sharesOf, branch }) {
    const { pair, oracle, borrower, liquidator, assetToken, collateralToken } = m;
    await m.wethFeed.setAnswer((BigInt(wethUsd) * 10n ** 8n).toString());

    const tb = va(await pair.totalBorrow());
    const ta = va(await pair.totalAsset());
    const rateInfo = await pair.currentRateInfo();
    expect(rateInfo.feeToProtocolRate).to.equal(0n);
    expect(tb.amount).to.not.equal(tb.shares); // fractional share price from accrued interest
    const coll = await pair.userCollateralBalance(borrower.address);
    const borrowerShares = await pair.userBorrowShares(borrower.address);
    let cum = await pair.cumulativeBadDebtWriteOff();
    const epochStart = await pair.badDebtEpochStart();
    const protocol0 = await pair.userCollateralBalance(pair.target);
    const liqColl0 = await collateralToken.balanceOf(liquidator.address);
    const liqAsset0 = await assetToken.balanceOf(liquidator.address);
    const [, low] = await oracle.getPrices();
    const clean = await pair.cleanLiquidationFee();
    const dirty = await pair.dirtyLiquidationFee();
    const proto = await pair.protocolLiquidationFee();

    // interest accrued by the liquidation's own _addInterest()
    const ts = BigInt(await time.latest()) + 100n;
    const interest = ((ts - rateInfo.lastTimestamp) * tb.amount * m.flatRate) / E18;
    expect(interest).to.be.gt(0n);
    const tb1 = { amount: tb.amount + interest, shares: tb.shares };
    const ta1 = { amount: ta.amount + interest, shares: ta.shares };
    if (ts >= epochStart + 86_400n) cum = 0n;

    const s = sharesOf(borrowerShares);
    const L = (vaToAmount(tb1, s, false) * low) / E18; // debt value, rounded down
    const optimistic = (L * (LIQ + clean)) / LIQ;
    const leftover = coll - optimistic;
    const gross = leftover <= 0n ? coll : (L * (LIQ + dirty)) / LIQ;
    const fee = proto > 0n && gross > L ? (proto * (gross - L)) / LIQ : 0n; // rounded down
    const net = gross - fee;
    const repay = vaToAmount(tb1, s, true); // rounded up
    let sharesToAdjust = 0n;
    let amountToAdjust = 0n;
    if (leftover <= 0n) {
        sharesToAdjust = borrowerShares - s;
        if (sharesToAdjust > 0n) {
            amountToAdjust = vaToAmount(tb1, sharesToAdjust, false);
            const maxWriteOff = (ta1.amount * 500n) / 10_000n;
            expect(amountToAdjust).to.be.lte(maxWriteOff - cum); // scenario stays under the write-off caps
        }
    }
    const modelBranch = leftover > 0n ? "dirty" : sharesToAdjust > 0n ? "clean-writeoff" : "clean";
    expect(modelBranch).to.equal(branch);
    expect(gross).to.be.gt(L); // positive bonus in every scenario here
    expect(fee).to.be.gt(0n);

    await time.setNextBlockTimestamp(ts);
    const tx = await pair.connect(liquidator).liquidate(s, ts + 3600n, borrower.address);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => pair.interface.parseLog(l)).find((l) => l && l.name === "Liquidate");

    expect(ev.args._collateralForLiquidator).to.equal(net);
    expect(ev.args._feesAmount).to.equal(fee);
    expect(ev.args._amountLiquidatorToRepay).to.equal(repay);
    expect(ev.args._sharesToAdjust).to.equal(sharesToAdjust);
    expect(ev.args._amountToAdjust).to.equal(amountToAdjust);
    expect((await collateralToken.balanceOf(liquidator.address)) - liqColl0).to.equal(net);
    expect(liqAsset0 - (await assetToken.balanceOf(liquidator.address))).to.equal(repay);
    expect((await pair.userCollateralBalance(pair.target)) - protocol0).to.equal(fee);
    expect(await pair.userCollateralBalance(borrower.address)).to.equal(coll - gross);
    expect(await pair.userBorrowShares(borrower.address)).to.equal(borrowerShares - s - sharesToAdjust);
    expect(await pair.cumulativeBadDebtWriteOff()).to.equal(cum + amountToAdjust);
    const tbAfter = va(await pair.totalBorrow());
    expect(tbAfter.amount).to.equal(tb1.amount - amountToAdjust - repay);
    expect(tbAfter.shares).to.equal(tb1.shares - s - sharesToAdjust);
    expect((await pair.totalAsset())[0]).to.equal(ta1.amount - amountToAdjust);
    return { net, fee, gross, L, repay, amountToAdjust };
}

/// Pair at the uint128 accounting ceiling: flat uint64.max per-second rate (accepted by validation),
/// 18-decimal asset, 1 WETH borrowed, accrued once per block until totalAsset.amount == 2^128 - 1.
async function fxAtCeiling() {
    const ctx = await build({ rate: "zero" });
    const { core, pair, usdc, weth, signers, wethFeed, oracle } = ctx;
    const flat = await (await ethers.getContractFactory("LinearInterestRate")).deploy("max", 80000, U64_MAX, U64_MAX, U64_MAX);
    const timelock = await impersonate(core.timelock.target);
    await pair.connect(timelock).setRateContract(flat.target);
    const [, , , , lender, , borrower, liquidator] = signers;
    await fund(weth, lender, pair, weth18("2"));
    await pair.connect(lender).deposit(weth18("2"), lender.address);
    await fund(usdc, borrower, pair, usdc6("4000"));
    await pair.connect(borrower).borrowAsset(weth18("1"), usdc6("4000"), borrower.address); // LTV 60%
    let updates = 0;
    while ((await pair.totalAsset())[0] < U128_MAX) {
        await pair.addInterest(false);
        updates++;
        if (updates > 40) throw new Error("ceiling not reached");
    }
    await fund(weth, borrower, pair, 10n ** 24n);
    await fund(weth, liquidator, pair, 10n ** 24n);
    return { ...ctx, flat, lender, borrower, liquidator, updates };
}

async function expectAccrualSkippedAtCeiling(pair, rc, before) {
    const blk = await ethers.provider.getBlock(rc.blockNumber);
    const info = await pair.currentRateInfo();
    expect(info.lastTimestamp).to.equal(BigInt(blk.timestamp)); // timestamp still advances
    expect(info.lastTimestamp).to.be.gt(before.lastTimestamp);
    const ev = rc.logs.map((l) => pair.interface.parseLog(l)).find((l) => l && l.name === "AddInterest");
    expect(ev.args.interestEarned).to.equal(0n); // nothing accrued: no headroom left
    expect((await pair.totalAsset())[0]).to.equal(U128_MAX);
}

/// Pair at exactly 100% utilization with the accepted-edge curve (vertex 99.999%). Lender deposits
/// 1 WETH; borrower borrows everything (1 WETH + seed) against 3,300 USDC (LTV 72.7% at $2400).
async function fullUtilBase() {
    const ctx = await build({ rate: { vertexUtilization: "99999" } });
    const { pair, usdc, weth, signers } = ctx;
    const [, , , , lender, , borrower, liquidator] = signers;
    await fund(weth, lender, pair, weth18("1"));
    await pair.connect(lender).deposit(weth18("1"), lender.address);
    const all = (await pair.totalAsset())[0] - (await pair.totalBorrow())[0];
    await fund(usdc, borrower, pair, usdc6("3300"));
    await pair.connect(borrower).borrowAsset(all, usdc6("3300"), borrower.address);
    await fund(weth, borrower, pair, weth18("1"));
    await fund(weth, liquidator, pair, weth18("2"));
    return { ...ctx, lender, borrower, liquidator };
}
async function fxFullUtilPause() {
    return fullUtilBase();
}
async function fxFullUtilRepay() {
    return fullUtilBase();
}
async function fxFullUtilLiquidate() {
    const ctx = await fullUtilBase();
    await ctx.wethFeed.setAnswer((2600n * 10n ** 8n).toString()); // LTV 78.8% -> liquidatable
    return ctx;
}

async function expectFullUtilizationNow(pair) {
    const ta = (await pair.totalAsset())[0];
    const tb = (await pair.totalBorrow())[0];
    expect(tb).to.equal(ta);
    expect((100_000n * tb) / ta).to.equal(100_000n); // the utilization formula in _calculateInterest
    const [pa, , pb] = await pair.getPairAccounting(); // with interest previewed
    expect((100_000n * pb) / pa).to.equal(100_000n);
    return pair.currentRateInfo();
}

/// The call's own accrual ran at utilization 100%: its new rate equals the curve evaluated at 100%.
async function expectAccruedAtFullUtil(pair, rate, rc, before) {
    const blk = await ethers.provider.getBlock(rc.blockNumber);
    const dt = BigInt(blk.timestamp) - before.lastTimestamp;
    const [r100, f100] = await rate.getNewRate(dt, 100_000n, before.fullUtilizationRate);
    const [r99] = await rate.getNewRate(dt, 99_999n, before.fullUtilizationRate);
    expect(r100).to.not.equal(r99);
    const ev = rc.logs.map((l) => pair.interface.parseLog(l)).find((l) => l && l.name === "UpdateRate");
    expect(ev.args.newRatePerSec).to.equal(r100);
    expect(ev.args.newFullUtilizationRate).to.equal(f100);
}

describe("S5a round 1: Codex review fixes", function () {
    describe("A: dirty liquidation fee <= clean liquidation fee", function () {
        it("setLiquidationFees rejects dirty > clean (incl. Codex's 5% / 50% case); dirty == clean is accepted", async function () {
            const { Pair, deployDirect, timelock } = await directPairFactory();
            const pair = await deployDirect({ maxLTV: 75000n, cleanLiquidationFee: 10000n });
            const set = (c, d, p) => () => pair.connect(timelock).setLiquidationFees(c, d, p);
            await expectRejected(set(5000n, 50000n, 10000n), Pair, "InvalidLiquidationFee");
            await expectRejected(set(5000n, 5001n, 10000n), Pair, "InvalidLiquidationFee");
            await pair.connect(timelock).setLiquidationFees(5000n, 5000n, 10000n);
            expect(await pair.dirtyLiquidationFee()).to.equal(5000n);
            expect(await pair.cleanLiquidationFee()).to.equal(5000n);
        });

        it("the dirty path at dirty == clean never seizes more than the borrower's collateral", async function () {
            // spec pair, then the timelock sets dirty == clean == 5%. Repaid value 2,800 of 3,000 collateral:
            // L * 1.05 = 2,940 < 3,000 -> dirty path, seizure 2,940 <= 3,000.
            const ctx = await build({ maxLTV: "75000", cleanLiquidationFee: "5000", protocolLiquidationFee: "10000", rate: "zero" });
            const { pair, usdc, weth, wethFeed, signers, core } = ctx;
            const [, , , , lender, , borrower, liquidator] = signers;
            const tl = await impersonate(core.timelock.target);
            await expectRejected(() => pair.connect(tl).setLiquidationFees(5000n, 50000n, 10000n), pair, "InvalidLiquidationFee");
            await pair.connect(tl).setLiquidationFees(5000n, 5000n, 10000n);
            await fund(weth, lender, pair, weth18("10"));
            await pair.connect(lender).deposit(weth18("10"), lender.address);
            await fund(usdc, borrower, pair, usdc6("3000"));
            await pair.connect(borrower).borrowAsset(weth18("0.9"), usdc6("3000"), borrower.address);
            await fund(weth, liquidator, pair, weth18("1"));
            await wethFeed.setAnswer((3200n * 10n ** 8n).toString()); // LTV 96%
            await time.increase(10);
            // 0.875 WETH * 3200 = 2800 USDC repaid value
            await pair.connect(liquidator).liquidate(weth18("0.875"), (await time.latest()) + 3600, borrower.address);
            // gross 2940, bonus 140, fee 14, liquidator 2926, borrower keeps 60
            expect(await usdc.balanceOf(liquidator.address)).to.equal(2_926_000_000n);
            expect(await pair.userCollateralBalance(pair.target)).to.equal(14_000_000n);
            expect(await pair.userCollateralBalance(borrower.address)).to.equal(60_000_000n);
        });
    });

    describe("B: VariableInterestRate clamps in uint256 before casting to uint64", function () {
        it("full utilization with MIN != MAX and an unclamped value >= 2^64 returns MAX (not a wrapped MIN)", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const MAX = 2n ** 63n;
            // vertex 90%, minUtil 50%, maxUtil 85%, zero 0, MIN 1, MAX 2^63, half-life 1 s
            const r = await VIR.deploy("b", 90000, 2n * 10n ** 17n, 50000, 85000, 0, 1n, MAX, 1n);
            // util 100%, elapsed 1 s: growth = (1e36 + 1e36) / 1e36 = 2 -> 2^63 * 2 = 2^64 before the clamp
            const [rate1, full1] = await r.getNewRate(1n, 100_000n, MAX);
            expect(full1).to.equal(MAX);
            expect(rate1).to.equal(MAX);
            // far above 2^64 before the clamp
            const [, full2] = await r.getNewRate(86_400n, 100_000n, MAX);
            expect(full2).to.equal(MAX);
            // growth from a mid value that crosses 2^64 only before clamping
            const [, full3] = await r.getNewRate(3n, 100_000n, 2n ** 62n + 1n);
            expect(full3).to.equal(MAX);
        });

        it("utilization above 100% is treated as 100%", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            const r = await VIR.deploy(...rateArgs(POC_RATE));
            for (const dt of [1n, 86_400n]) {
                for (const f of [3_189_000_000n, 9_500_000_000n]) {
                    const at100 = await r.getNewRate(dt, 100_000n, f);
                    for (const u of [100_001n, 200_000n, 10n ** 30n]) {
                        const over = await r.getNewRate(dt, u, f);
                        expect(over[0]).to.equal(at100[0]);
                        expect(over[1]).to.equal(at100[1]);
                    }
                }
            }
        });
    });

    describe("C: no revert at the uint128 accounting ceiling", function () {
        it("pause() succeeds with zero headroom (accrual skipped, timestamp advances)", async function () {
            const { pair, updates } = await loadFixture(fxAtCeiling);
            console.log(`      uint128 ceiling reached after ${updates} per-block accruals`);
            expect(updates).to.be.lte(20);
            expect((await pair.totalAsset())[0]).to.equal(U128_MAX);
            const before = await pair.currentRateInfo();
            const borrow0 = (await pair.totalBorrow())[0];
            const cb = await impersonate(await pair.circuitBreakerAddress());
            const rc = await (await pair.connect(cb).pause()).wait();
            await expectAccrualSkippedAtCeiling(pair, rc, before);
            expect((await pair.totalBorrow())[0]).to.equal(borrow0);
            expect(await pair.isInterestPaused()).to.equal(true);
        });

        it("repayAsset() succeeds with zero headroom and reduces debt by exactly the amount repaid", async function () {
            const { pair, weth, borrower } = await loadFixture(fxAtCeiling);
            expect((await pair.totalAsset())[0]).to.equal(U128_MAX);
            const before = await pair.currentRateInfo();
            const tb0 = va(await pair.totalBorrow());
            const shares0 = await pair.userBorrowShares(borrower.address);
            const owed = vaToAmount(tb0, 1000n, true); // no interest accrues in the call
            const bal0 = await weth.balanceOf(borrower.address);
            const rc = await (await pair.connect(borrower).repayAsset(1000n, borrower.address)).wait();
            await expectAccrualSkippedAtCeiling(pair, rc, before);
            expect(bal0 - (await weth.balanceOf(borrower.address))).to.equal(owed);
            const tb1 = va(await pair.totalBorrow());
            expect(tb1.amount).to.equal(tb0.amount - owed);
            expect(tb1.shares).to.equal(tb0.shares - 1000n);
            expect(await pair.userBorrowShares(borrower.address)).to.equal(shares0 - 1000n);
        });

        it("a partial liquidate() succeeds with zero headroom", async function () {
            const { pair, usdc, borrower, liquidator } = await loadFixture(fxAtCeiling);
            expect((await pair.totalAsset())[0]).to.equal(U128_MAX);
            const before = await pair.currentRateInfo();
            const shares0 = await pair.userBorrowShares(borrower.address);
            const rc = await (
                await pair.connect(liquidator).liquidate(1000n, (await time.latest()) + 3600, borrower.address)
            ).wait();
            const blk = await ethers.provider.getBlock(rc.blockNumber);
            const info = await pair.currentRateInfo();
            expect(info.lastTimestamp).to.equal(BigInt(blk.timestamp));
            expect(info.lastTimestamp).to.be.gt(before.lastTimestamp);
            const add = rc.logs.map((l) => pair.interface.parseLog(l)).find((l) => l && l.name === "AddInterest");
            expect(add.args.interestEarned).to.equal(0n);
            // repaid value far exceeds the collateral: clean path, all 4,000 USDC to the liquidator, no fee
            expect(await usdc.balanceOf(liquidator.address)).to.equal(usdc6("4000"));
            expect(await pair.userCollateralBalance(borrower.address)).to.equal(0n);
            const left = await pair.userBorrowShares(borrower.address);
            expect(left).to.be.lt(shares0 - 1000n); // part of the residual debt written off
            expect(left).to.be.gt(0n); // partial: the write-off cap leaves the rest
        });
    });

    describe("F: exact liquidation amounts with accrued interest (shares != amounts)", function () {
        const third = (s) => s / 3n;
        const all = (s) => s;
        const ninetyNine = (s) => (s * 99n) / 100n;

        it("WETH debt / USDC collateral: dirty path", async function () {
            const m = await loadFixture(fxWethDebtAccrued);
            await liquidateExact(m, { wethUsd: 2600, sharesOf: third, branch: "dirty" });
        });
        it("WETH debt / USDC collateral: clean path, positive bonus, no write-off", async function () {
            const m = await loadFixture(fxWethDebtAccrued);
            await liquidateExact(m, { wethUsd: 3112, sharesOf: all, branch: "clean" });
        });
        it("WETH debt / USDC collateral: clean path with write-off", async function () {
            const m = await loadFixture(fxWethDebtAccrued);
            await liquidateExact(m, { wethUsd: 3112, sharesOf: ninetyNine, branch: "clean-writeoff" });
        });
        it("USDC debt / WETH collateral: dirty path", async function () {
            const m = await loadFixture(fxUsdcDebtAccrued);
            await liquidateExact(m, { wethUsd: 2250, sharesOf: third, branch: "dirty" });
        });
        it("USDC debt / WETH collateral: clean path, positive bonus, no write-off", async function () {
            const m = await loadFixture(fxUsdcDebtAccrued);
            await liquidateExact(m, { wethUsd: 1815, sharesOf: all, branch: "clean" });
        });
        it("USDC debt / WETH collateral: clean path with write-off", async function () {
            const m = await loadFixture(fxUsdcDebtAccrued);
            await liquidateExact(m, { wethUsd: 1815, sharesOf: ninetyNine, branch: "clean-writeoff" });
        });
    });

    describe("G: liveness at exactly 100% utilization (vertex 99.999%)", function () {
        it("pause()", async function () {
            const { pair, interestRate } = await loadFixture(fxFullUtilPause);
            const before = await expectFullUtilizationNow(pair);
            const cb = await impersonate(await pair.circuitBreakerAddress());
            const rc = await (await pair.connect(cb).pause()).wait();
            await expectAccruedAtFullUtil(pair, interestRate, rc, before);
            expect(await pair.isInterestPaused()).to.equal(true);
        });

        it("repayAsset()", async function () {
            const { pair, interestRate, borrower } = await loadFixture(fxFullUtilRepay);
            const before = await expectFullUtilizationNow(pair);
            const shares = await pair.userBorrowShares(borrower.address);
            const rc = await (await pair.connect(borrower).repayAsset(shares / 2n, borrower.address)).wait();
            await expectAccruedAtFullUtil(pair, interestRate, rc, before);
            expect(await pair.userBorrowShares(borrower.address)).to.equal(shares - shares / 2n);
        });

        it("liquidate()", async function () {
            const { pair, interestRate, borrower, liquidator, usdc } = await loadFixture(fxFullUtilLiquidate);
            const before = await expectFullUtilizationNow(pair);
            const shares = await pair.userBorrowShares(borrower.address);
            const rc = await (
                await pair.connect(liquidator).liquidate(shares / 2n, (await time.latest()) + 3600, borrower.address)
            ).wait();
            await expectAccruedAtFullUtil(pair, interestRate, rc, before);
            expect(await pair.userBorrowShares(borrower.address)).to.equal(shares - shares / 2n);
            expect(await usdc.balanceOf(liquidator.address)).to.be.gt(0n);
        });
    });
});
