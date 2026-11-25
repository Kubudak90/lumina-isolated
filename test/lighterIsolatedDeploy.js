// S5c: the Lighter isolated deploy parameters (scripts/lighter/isolated-params.js, the values
// scripts/deploy-lighter-isolated.js deploys) and its on-chain sequence, on the in-process network
// with a stand-in dual oracle. The harness run (lumina-monorepo harness/deploy) proves the same
// sequence against the real LighterDualOracle, guard and Safe.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const P = require("../scripts/lighter/isolated-params");
const setup = require("./utils/setup");

const TWO_DAYS = 172_800;
const U64_MAX = 2n ** 64n - 1n;
// Spec 3.1 pair parameters as the manifest carries them (basis points).
const SPEC = { maxLtvBps: 7500, cleanLiquidationFeeBps: 500, protocolLiquidationFeeShareBps: 1000 };
const SEED = 25_000_000n; // 25 USDC, the harness seed of the USDC/WETH pair

describe("Lighter isolated deploy (S5c)", function () {
    describe("rate calculator parameters", function () {
        async function deployCalculator() {
            const calc = await (await ethers.getContractFactory("VariableInterestRate")).deploy(...P.rateCalculatorArgs());
            return { calc };
        }

        it("pass the VariableInterestRate constructor validation and read back as configured", async function () {
            const { calc } = await loadFixture(deployCalculator);
            for (const [getter, expected] of Object.entries(P.rateCalculatorImmutables())) {
                expect(await calc[getter](), getter).to.equal(expected);
            }
            expect(await calc.suffix()).to.equal(P.RATE_CALCULATOR.suffix);
        });

        it("getNewRate at 0%, the vertex and 100% utilization never reverts and stays within the bounds", async function () {
            const { calc } = await loadFixture(deployCalculator);
            const rows = await P.simulateRates(calc);
            expect(rows.length).to.equal(60);
            const at = (util) => rows.find((r) => r.deltaTime === 1n && r.fullRateIn === P.PAIR.fullUtilizationRate && r.utilization === util);
            // 0%: below the 70% target band, the full rate decays; the rate is 0 anyway.
            expect(at(0n).ratePerSec).to.equal(0n);
            // The vertex (80%) is inside the 70-85% band: no adaptation, 10% of the full rate.
            expect(at(80_000n).newFullRate).to.equal(P.PAIR.fullUtilizationRate);
            expect(at(80_000n).ratePerSec).to.equal(P.PAIR.fullUtilizationRate / 10n);
            // 100%: above the band, the full rate grows (2-day half life); the rate is the new full rate.
            expect(at(100_000n).newFullRate).to.be.gt(P.PAIR.fullUtilizationRate);
            expect(at(100_000n).newFullRate - P.PAIR.fullUtilizationRate).to.be.lt(P.PAIR.fullUtilizationRate / 10_000n);
            expect(at(100_000n).ratePerSec).to.equal(at(100_000n).newFullRate);
            // Over 100% utilization (defence in depth in the calculator) and a uint64 delta still return.
            const [rate, full] = await calc.getNewRate(U64_MAX, 250_000n, U64_MAX);
            expect(full).to.equal(P.RATE_CALCULATOR.maxFullUtilizationRate);
            expect(rate).to.equal(full);
        });

        it("APR conversions: 25% / 50% / 100% APR, start rate within the adaptive range", function () {
            expect(P.ratePerSecToAprPercent(P.RATE_CALCULATOR.minFullUtilizationRate)).to.be.closeTo(25, 1e-6);
            expect(P.ratePerSecToAprPercent(P.PAIR.fullUtilizationRate)).to.be.closeTo(50, 1e-6);
            expect(P.ratePerSecToAprPercent(P.RATE_CALCULATOR.maxFullUtilizationRate)).to.be.closeTo(100, 1e-6);
            expect(P.PAIR.fullUtilizationRate).to.be.gte(P.RATE_CALCULATOR.minFullUtilizationRate);
            expect(P.PAIR.fullUtilizationRate).to.be.lte(P.RATE_CALCULATOR.maxFullUtilizationRate);
            expect(P.bpsTo1e5(SPEC.maxLtvBps)).to.equal(75_000n);
            expect(P.e5ToBps(4_500n, "dirty")).to.equal(450);
            expect(() => P.e5ToBps(4_501n, "dirty")).to.throw(/not a whole number of basis points/);
        });
    });

    describe("deploy sequence (as scripts/deploy-lighter-isolated.js)", function () {
        async function deployStack() {
            const [deployer, safe, lender, borrower, stranger] = await ethers.getSigners();
            const Token = await ethers.getContractFactory("MockERC20");
            const usdc = await Token.deploy("USD Coin", "USDC", 6);
            const weth = await Token.deploy("Wrapped Ether", "WETH", 18);
            const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();

            const timelock = await (await ethers.getContractFactory("Timelock")).deploy(safe.address, TWO_DAYS);
            const whitelist = await (await ethers.getContractFactory("LightlendWhitelist")).deploy();
            const registry = await (await ethers.getContractFactory("LightlendPairRegistry")).deploy(deployer.address, []);
            const pd = await (await ethers.getContractFactory("LightlendPairDeployer")).deploy({
                circuitBreaker: safe.address,
                comptroller: safe.address,
                timelock: timelock.target,
                lightlendWhitelist: whitelist.target,
                lightlendPairRegistry: registry.target,
            });
            const calc = await (await ethers.getContractFactory("VariableInterestRate")).deploy(...P.rateCalculatorArgs());

            const pairArtifact = await artifacts.readArtifact("LightlendPair");
            await pd.setCreationCode(pairArtifact.bytecode);
            await registry.setDeployers([pd.target], true);
            await pd.setSeedAmount(usdc.target, SEED);
            await whitelist.setLightlendDeployerWhitelist([deployer.address], true);

            const configData = P.encodePairConfig(ethers.AbiCoder.defaultAbiCoder(), {
                asset: usdc.target,
                collateral: weth.target,
                oracle: oracle.target,
                maxOracleDeviation: P.PAIR.maxOracleDeviation,
                rateContract: calc.target,
                fullUtilizationRate: P.PAIR.fullUtilizationRate,
                maxLTV: P.bpsTo1e5(SPEC.maxLtvBps),
                cleanLiquidationFee: P.bpsTo1e5(SPEC.cleanLiquidationFeeBps),
                protocolLiquidationFee: P.bpsTo1e5(SPEC.protocolLiquidationFeeShareBps),
            });
            return { deployer, safe, lender, borrower, stranger, usdc, weth, oracle, timelock, whitelist, registry, pd, calc, configData };
        }

        async function deployedPair() {
            const f = await deployStack();
            await f.usdc.mint(f.deployer.address, SEED);
            await f.usdc.transfer(f.pd.target, SEED); // the script funds the pair deployer contract
            const tx = await f.pd.deploy(f.configData);
            const receipt = await tx.wait();
            const ev = receipt.logs.map((l) => f.pd.interface.parseLog(l)).find((e) => e?.name === "LogDeploy");
            const pair = await ethers.getContractAt("LightlendPair", ev.args.address_);
            return { ...f, pair, receipt };
        }

        it("the config encoding round-trips", async function () {
            const { configData, usdc, weth, oracle, calc } = await loadFixture(deployStack);
            const c = P.decodePairConfig(ethers.AbiCoder.defaultAbiCoder(), configData);
            expect(c.asset).to.equal(usdc.target);
            expect(c.collateral).to.equal(weth.target);
            expect(c.oracle).to.equal(oracle.target);
            expect(c.rateContract).to.equal(calc.target);
            expect(c.maxLTV).to.equal(75_000n);
            expect(c.cleanLiquidationFee).to.equal(5_000n);
            expect(c.protocolLiquidationFee).to.equal(10_000n);
        });

        it("deploy() reverts while the pair deployer contract holds no seed (the old script's bug)", async function () {
            const { pd, configData, usdc, deployer } = await loadFixture(deployStack);
            await usdc.mint(deployer.address, SEED); // held by the EOA, not by the pair deployer
            await expect(pd.deploy(configData)).to.be.reverted;
        });

        it("creates, registers and seeds the pair in one transaction; owner, circuit breaker and timelock from construction; spec 3.1 parameters", async function () {
            const { pair, pd, registry, usdc, safe, timelock, oracle, calc, receipt } = await loadFixture(deployedPair);
            expect(await pair.owner()).to.equal(safe.address);
            expect(await pair.circuitBreakerAddress()).to.equal(safe.address);
            expect(await pair.timelockAddress()).to.equal(timelock.target);
            expect(await pair.DEPLOYER_ADDRESS()).to.equal(pd.target);
            expect(await pair.maxLTV()).to.equal(75_000n);
            expect(await pair.cleanLiquidationFee()).to.equal(5_000n);
            expect(await pair.dirtyLiquidationFee()).to.equal(4_500n);
            expect(await pair.protocolLiquidationFee()).to.equal(10_000n);
            expect(await pair.rateContract()).to.equal(calc.target);
            const info = await pair.exchangeRateInfo();
            expect(info.oracle).to.equal(oracle.target);
            expect(info.maxOracleDeviation).to.equal(P.PAIR.maxOracleDeviation);
            // The constructor's first accrual (1 s at 0% utilization) already decays the start rate slightly.
            const full = (await pair.currentRateInfo()).fullUtilizationRate;
            expect(full).to.be.lte(P.PAIR.fullUtilizationRate);
            expect(P.PAIR.fullUtilizationRate - full).to.be.lt(P.PAIR.fullUtilizationRate / 10_000n);
            expect(await registry.deployedPairsByName(await pair.name())).to.equal(pair.target);
            expect(await pd.isDeployedPair(pair.target)).to.equal(true);
            // Seed: in the creation transaction, shares held by the pair deployer (no redeem path).
            const deposit = receipt.logs.filter((l) => l.address === pair.target).map((l) => pair.interface.parseLog(l)).find((e) => e?.name === "Deposit");
            expect(deposit.args.caller).to.equal(pd.target);
            expect(deposit.args.owner).to.equal(pd.target);
            expect(deposit.args.assets).to.equal(SEED);
            expect(await pair.balanceOf(pd.target)).to.equal(deposit.args.shares);
            expect(await usdc.balanceOf(pd.target)).to.equal(0n);
            expect(await pair.deployerSwapperRevoked()).to.equal(false);
        });

        it("handover: the Safe revokes swapper access and accepts the whitelist and registry; the deployer ends with nothing", async function () {
            const { pair, pd, registry, whitelist, deployer, safe, stranger } = await loadFixture(deployedPair);
            await expect(pair.connect(deployer).revokeDeployerSwapperAccess()).to.be.reverted; // only the owner (Safe)
            await pair.connect(safe).revokeDeployerSwapperAccess();
            expect(await pair.deployerSwapperRevoked()).to.equal(true);

            await whitelist.setLightlendDeployerWhitelist([deployer.address], false);
            await whitelist.transferOwnership(safe.address);
            await registry.transferOwnership(safe.address);
            await pd.transferOwnership(safe.address);
            expect(await whitelist.pendingOwner()).to.equal(safe.address);
            expect(await registry.pendingOwner()).to.equal(safe.address);
            await whitelist.connect(safe).acceptOwnership();
            await registry.connect(safe).acceptOwnership();

            for (const c of [whitelist, registry, pd]) expect(await c.owner()).to.equal(safe.address);
            expect(await whitelist.pendingOwner()).to.equal(ethers.ZeroAddress);
            expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
            expect(await whitelist.lightlendDeployerWhitelist(deployer.address)).to.equal(false);
            expect(await registry.deployers(deployer.address)).to.equal(false);
            expect(await pd.circuitBreakerAddress()).to.equal(safe.address);
            // The deployer can no longer configure or deploy.
            await expect(pd.connect(deployer).setSeedAmount(stranger.address, 1n)).to.be.reverted;
            await expect(pd.connect(deployer).deploy("0x")).to.be.reverted;
        });

        it("globalPause by the Safe (circuit breaker); unpause only after the 2-day Timelock delay", async function () {
            const { pair, pd, timelock, safe, deployer } = await loadFixture(deployedPair);
            await expect(pd.connect(deployer).globalPause([pair.target])).to.be.revertedWithCustomError(pd, "CircuitBreakerOnly");
            await pd.connect(safe).globalPause([pair.target]);
            expect(await pair.borrowLimit()).to.equal(0n);
            expect(await pair.depositLimit()).to.equal(0n);
            expect(await pair.isWithdrawPaused()).to.equal(true);
            expect(await pair.isInterestPaused()).to.equal(true);

            const eta = BigInt(await time.latest()) + BigInt(TWO_DAYS) + 10n;
            await expect(timelock.connect(safe).queueTransaction(pair.target, 0, "unpause()", "0x", BigInt(await time.latest()) + BigInt(TWO_DAYS) - 10n)).to.be.reverted;
            await timelock.connect(safe).queueTransaction(pair.target, 0, "unpause()", "0x", eta);
            await time.setNextBlockTimestamp(eta - 1n);
            await expect(timelock.connect(safe).executeTransaction(pair.target, 0, "unpause()", "0x", eta)).to.be.reverted;
            await time.setNextBlockTimestamp(eta);
            await timelock.connect(safe).executeTransaction(pair.target, 0, "unpause()", "0x", eta);
            expect(await pair.borrowLimit()).to.equal(ethers.MaxUint256);
            expect(await pair.depositLimit()).to.equal(ethers.MaxUint256);
            expect(await pair.isWithdrawPaused()).to.equal(false);
            expect(await pair.isInterestPaused()).to.equal(false);
        });

        it("F4 limits: Safe sets depositLimit/borrowLimit, deposits and borrows above them revert, unpause resets to MaxUint256", async function () {
            const f = await loadFixture(deployStack);
            const { pd, timelock, usdc, weth, safe, lender, borrower, deployer, calc } = f;
            // Use a 0-deviation DualOracle (MockOracle has >3x low/high spread) so borrowAsset reaches borrowLimit.
            const usdcFeed = await setup.deployMockChainlinkOracle("100000000");
            const wethFeed = await setup.deployMockChainlinkOracle("300000000000");
            const { oracle: zeroDevOracle } = await setup.deployOracle({
                baseToken: usdc.target,
                quoteToken: weth.target,
                chainlinkMultiplyAddress: usdcFeed.target,
                chainlinkDivideAddress: wethFeed.target,
                maxOracleDelay: "1000000",
                timelockAddress: timelock.target,
                name: "f4-limits",
            });
            const configData = P.encodePairConfig(ethers.AbiCoder.defaultAbiCoder(), {
                asset: usdc.target,
                collateral: weth.target,
                oracle: zeroDevOracle.target,
                maxOracleDeviation: P.PAIR.maxOracleDeviation,
                rateContract: calc.target,
                fullUtilizationRate: P.PAIR.fullUtilizationRate,
                maxLTV: P.bpsTo1e5(SPEC.maxLtvBps),
                cleanLiquidationFee: P.bpsTo1e5(SPEC.cleanLiquidationFeeBps),
                protocolLiquidationFee: P.bpsTo1e5(SPEC.protocolLiquidationFeeShareBps),
            });
            await usdc.mint(deployer.address, SEED);
            await usdc.transfer(pd.target, SEED);
            const receipt = await (await pd.deploy(configData)).wait();
            const ev = receipt.logs.map((l) => pd.interface.parseLog(l)).find((e) => e?.name === "LogDeploy");
            const pair = await ethers.getContractAt("LightlendPair", ev.args.address_);

            const depositLimit = 150_000_000_000n; // 150,000 USDC
            const borrowLimit = 75_000_000_000n;   // 75,000 USDC

            // Deployer (non-owner) cannot set limits
            await expect(pair.connect(deployer).setDepositLimit(depositLimit)).to.be.revertedWithCustomError(pair, "OnlyTimelockOrOwner");
            await expect(pair.connect(deployer).setBorrowLimit(borrowLimit)).to.be.revertedWithCustomError(pair, "OnlyTimelockOrOwner");

            // Safe sets both limits
            await pair.connect(safe).setDepositLimit(depositLimit);
            await pair.connect(safe).setBorrowLimit(borrowLimit);
            expect(await pair.depositLimit()).to.equal(depositLimit);
            expect(await pair.borrowLimit()).to.equal(borrowLimit);

            // Deposit above depositLimit reverts ExceedsDepositLimit
            const overDeposit = depositLimit - SEED + 1n;
            await usdc.mint(lender.address, overDeposit);
            await usdc.connect(lender).approve(pair.target, overDeposit);
            await expect(pair.connect(lender).deposit(overDeposit, lender.address)).to.be.revertedWithCustomError(pair, "ExceedsDepositLimit");

            // Deposit up to depositLimit succeeds
            const okDeposit = depositLimit - SEED;
            await pair.connect(lender).deposit(okDeposit, lender.address);

            // Borrow above borrowLimit reverts ExceedsBorrowLimit (with ample collateral)
            const hugeCollateral = ethers.parseEther("1000");
            await weth.mint(borrower.address, hugeCollateral);
            await weth.connect(borrower).approve(pair.target, hugeCollateral);
            await pair.connect(borrower).addCollateral(hugeCollateral, borrower.address);
            await expect(pair.connect(borrower).borrowAsset(borrowLimit + 1n, 0n, borrower.address)).to.be.revertedWithCustomError(pair, "ExceedsBorrowLimit");

            // Borrow at borrowLimit succeeds
            await pair.connect(borrower).borrowAsset(borrowLimit, 0n, borrower.address);
            const [totalAssets, , totalBorrows] = await pair.getPairAccounting();
            expect(totalAssets).to.be.lte(depositLimit);
            expect(totalBorrows).to.be.lte(borrowLimit);

            // globalPause + Timelock unpause resets limits to MaxUint256, requiring Safe to re-apply
            await pd.connect(safe).globalPause([pair.target]);
            const eta = BigInt(await time.latest()) + BigInt(TWO_DAYS) + 10n;
            await timelock.connect(safe).queueTransaction(pair.target, 0, "unpause()", "0x", eta);
            await time.setNextBlockTimestamp(eta);
            await timelock.connect(safe).executeTransaction(pair.target, 0, "unpause()", "0x", eta);
            expect(await pair.depositLimit()).to.equal(ethers.MaxUint256);
            expect(await pair.borrowLimit()).to.equal(ethers.MaxUint256);
            await pair.connect(safe).setDepositLimit(depositLimit);
            await pair.connect(safe).setBorrowLimit(borrowLimit);
            expect(await pair.depositLimit()).to.equal(depositLimit);
            expect(await pair.borrowLimit()).to.equal(borrowLimit);
        });
    });

    describe("AF1/F2 explicit gas helper (boundedGas)", function () {
        it("adds 25% buffer by default and adds GUARD_CALL_GAS + GUARD_GAS_BUFFER when requested", function () {
            expect(P.GUARD_CALL_GAS).to.equal(1_000_000n);
            expect(P.GUARD_GAS_BUFFER).to.equal(100_000n);
            expect(P.boundedGas(1_000_000n, 17_000_000n)).to.equal(1_250_000n);
            // Pair deploy / liquidate with guard stipend: >= estimate + 1_100_000
            const withStipend = P.boundedGas(300_000n, 17_000_000n, { extraGas: P.GUARD_CALL_GAS + P.GUARD_GAS_BUFFER });
            expect(withStipend).to.equal(375_000n + 1_100_000n);
            // Capped at EIP-7825 TX_GAS_CAP (16_777_216) when buffered exceeds cap but estimate + extraGas fits
            expect(P.boundedGas(15_000_000n, 17_000_000n, { extraGas: 1_100_000n })).to.equal(P.TX_GAS_CAP);
            // Throws when estimate + extraGas itself exceeds cap
            expect(() => P.boundedGas(16_000_000n, 17_000_000n, { extraGas: 1_100_000n })).to.throw(/exceeds the per-transaction cap/);
        });
    });
});
