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
    const wethFeed = await setup.deployMockChainlinkOracle((2400n * 10n ** 8n).toString());
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
            await expectRejected(set(2499n, 2500n, 20000n), Pair, "InsufficientLiquidatorBonus"); // clean binds
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

            // (b) highest allowed maxLTV for a 10% clean fee: floor(98% / 1.1) = 89.090%
            const { pair, usdc, weth, wethFeed, signers } = await build({ maxLTV: "89090", cleanLiquidationFee: "10000" });
            const [, , , , A, , attacker, attacker2] = signers;
            await fund(weth, A, pair, weth18("10"));
            await pair.connect(A).deposit(weth18("10"), A.address);
            await fund(usdc, attacker, pair, usdc6("10000"));
            await pair.connect(attacker).borrowAsset(weth18("3.71"), usdc6("10000"), attacker2.address); // LTV 89.04%
            await wethFeed.setAnswer((2448n * 10n ** 8n).toString()); // +2% tick, LTV 90.8%
            await time.increase(10);
            const extra = weth18("0.001"); // covers accrued interest; not the attacker's capital
            await fund(weth, attacker2, pair, extra);
            // A clean liquidation needs repaid * 1.1 >= collateral, i.e. more debt than exists, so the
            // attacker can only liquidate all of its debt on the dirty path.
            const shares = await pair.userBorrowShares(attacker.address);
            await pair.connect(attacker2).liquidate(shares, (await time.latest()) + 3600, attacker.address);
            expect(await pair.cumulativeBadDebtWriteOff()).to.equal(0n);
            expect(await pair.userBorrowShares(attacker.address)).to.equal(0n);
            const left = await pair.userCollateralBalance(attacker.address);
            await pair.connect(attacker).removeCollateral(left, attacker.address);
            const usdcEnd = (await usdc.balanceOf(attacker.address)) + (await usdc.balanceOf(attacker2.address));
            const wethNet = (await weth.balanceOf(attacker2.address)) - extra; // signed
            const endUsd = usdcEnd + (wethNet * 2448n) / 10n ** 12n;
            expect(endUsd).to.be.lt(usdc6("10000"));
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
        it("PoC-F port: vertexUtilization = 100% is rejected; at 99.999% a fully utilized pair keeps working", async function () {
            const VIR = await ethers.getContractFactory("VariableInterestRate");
            await expect(VIR.deploy(...rateArgs({ ...POC_RATE, vertexUtilization: "100000" }))).to.be.reverted;

            const { pair, usdc, weth, signers, interestRate } = await build({ rate: { vertexUtilization: "99999" } });
            expect(await interestRate.VERTEX_UTILIZATION()).to.equal(99_999n);
            await expectRateNeverReverts(interestRate);
            const [, , , , A, , borrower] = signers;
            await fund(weth, A, pair, weth18("1"));
            await pair.connect(A).deposit(weth18("1"), A.address);
            const [ta, , tb] = await pair.getPairAccounting();
            await fund(usdc, borrower, pair, usdc6("100000"));
            await pair.connect(borrower).borrowAsset(ta - tb, usdc6("100000"), borrower.address); // 100% utilization
            await time.increase(10);
            await weth.mint(borrower.address, weth18("5"));
            await weth.connect(borrower).approve(pair.target, ethers.MaxUint256);
            await pair.addInterest(false);
            const shares = await pair.userBorrowShares(borrower.address);
            await pair.connect(borrower).repayAsset(shares / 2n, borrower.address);
            const cb = await impersonate(await pair.circuitBreakerAddress());
            await pair.connect(cb).pause(); // pause() runs _addInterest()
            await pair.connect(borrower).repayAsset(await pair.userBorrowShares(borrower.address), borrower.address);
            expect(await pair.userBorrowShares(borrower.address)).to.equal(0n);
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
