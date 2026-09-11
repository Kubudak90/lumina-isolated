const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const setup = require("./utils/setup");

const abi = ethers.AbiCoder.defaultAbiCoder();

function encodeConfig({
    asset,
    collateral,
    oracle,
    maxOracleDeviation = 5000,
    rateContract,
    fullUtilizationRate = 9500000000n,
    maxLTV = 75000n,
    cleanLiquidationFee = 10000n,
    protocolLiquidationFee = 1000n,
}) {
    return abi.encode(
        [
            "address",
            "address",
            "address",
            "uint32",
            "address",
            "uint64",
            "uint256",
            "uint256",
            "uint256",
        ],
        [
            asset,
            collateral,
            oracle,
            maxOracleDeviation,
            rateContract,
            fullUtilizationRate,
            maxLTV,
            cleanLiquidationFee,
            protocolLiquidationFee,
        ]
    );
}

function encodeImmutables(circuitBreaker, comptroller, timelock) {
    return abi.encode(["address", "address", "address"], [circuitBreaker, comptroller, timelock]);
}

function encodeCustom(name = "Test Pair", symbol = "TP", decimals = 18) {
    return abi.encode(["string", "string", "uint8"], [name, symbol, decimals]);
}

describe("Constructor, pause, and seed", function () {
    async function signers() {
        const [deployer, owner, timelock, circuitBreaker] = await ethers.getSigners();
        const asset = ethers.Wallet.createRandom().address;
        const collateral = ethers.Wallet.createRandom().address;
        const oracle = ethers.Wallet.createRandom().address;
        const rateContract = ethers.Wallet.createRandom().address;
        return { deployer, owner, timelock, circuitBreaker, asset, collateral, oracle, rateContract };
    }

    async function impersonate(addr) {
        await ethers.provider.send("hardhat_impersonateAccount", [addr]);
        await ethers.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]);
        return ethers.getSigner(addr);
    }

    async function deployListedPair(data, { asset, collateral }) {
        await data.mockTokens.WETH.mint(data.lightlendPairDeployer.target, ethers.parseUnits("1", 18));
        await data.mockTokens.USDC.mint(data.lightlendPairDeployer.target, ethers.parseUnits("1", 6));
        const pairAddress = await setup.deployPair({
            lightlendPairRegistry: data.lightlendPairRegistry.target,
            lightlendPairDeployerAddress: data.lightlendPairDeployer.target,
            assetTokenAddress: asset,
            collateralTokenAddress: collateral,
            interestRateAddress: data.interestRate.target,
            oracleAddress: data.oracle.target,
            maxOracleDeviation: "5000",
            fullUtilizationRate: "9500000000",
            maxLTV: "75000",
            cleanLiquidationFee: "10000",
            protocolLiquidationFee: "1000",
        });
        const pair = (await ethers.getContractFactory("LightlendPair")).attach(pairAddress);
        return pair;
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
        const deploymentInstancesMockTokens = await setup.deployMockTokens(["USDC", "WETH"], [6, 18]);
        const mockUsdcOracle = await setup.deployMockChainlinkOracle("100000000");
        const mockWethOracle = await setup.deployMockChainlinkOracle("240000000000");
        const oracleConfig = {
            baseToken: deploymentInstancesMockTokens.mockTokens.WETH.target,
            quoteToken: deploymentInstancesMockTokens.mockTokens.USDC.target,
            chainlinkMultiplyAddress: mockWethOracle.target,
            chainlinkDivideAddress: mockUsdcOracle.target,
            maxOracleDelay: "1000000",
            timelockAddress: deploymentInstancesCore.timelock.target,
            name: "MockChainlinkSingle",
        };
        const deploymentInstanceOracle = await setup.deployOracle(oracleConfig);
        return {
            ...deploymentInstancesCore,
            ...deploymentInstanceInterestRate,
            ...deploymentInstanceOracle,
            ...deploymentInstancesMockTokens,
        };
    }

    describe("ISO-01 constructor bounds", function () {
        it("rejects asset == collateral", async function () {
            const ctx = await signers();
            const Pair = await ethers.getContractFactory("LightlendPair");
            await expect(
                Pair.deploy(
                    encodeConfig({
                        asset: ctx.asset,
                        collateral: ctx.asset,
                        oracle: ctx.oracle,
                        rateContract: ctx.rateContract,
                    }),
                    encodeImmutables(ctx.circuitBreaker.address, ctx.owner.address, ctx.timelock.address),
                    encodeCustom()
                )
            ).to.be.revertedWithCustomError(Pair, "AssetEqualsCollateral");
        });

        it("rejects zero oracle deviation", async function () {
            const ctx = await signers();
            const Pair = await ethers.getContractFactory("LightlendPair");
            await expect(
                Pair.deploy(
                    encodeConfig({
                        asset: ctx.asset,
                        collateral: ctx.collateral,
                        oracle: ctx.oracle,
                        rateContract: ctx.rateContract,
                        maxOracleDeviation: 0,
                    }),
                    encodeImmutables(ctx.circuitBreaker.address, ctx.owner.address, ctx.timelock.address),
                    encodeCustom()
                )
            ).to.be.revertedWithCustomError(Pair, "InvalidOracleDeviation");
        });

        it("rejects liquidation fee that exceeds 50%", async function () {
            const ctx = await signers();
            const Pair = await ethers.getContractFactory("LightlendPair");
            await expect(
                Pair.deploy(
                    encodeConfig({
                        asset: ctx.asset,
                        collateral: ctx.collateral,
                        oracle: ctx.oracle,
                        rateContract: ctx.rateContract,
                        cleanLiquidationFee: 50_001n,
                    }),
                    encodeImmutables(ctx.circuitBreaker.address, ctx.owner.address, ctx.timelock.address),
                    encodeCustom()
                )
            ).to.be.revertedWithCustomError(Pair, "InvalidLiquidationFee");
        });

        it("rejects zero addresses", async function () {
            const ctx = await signers();
            const Pair = await ethers.getContractFactory("LightlendPair");
            await expect(
                Pair.deploy(
                    encodeConfig({
                        asset: ethers.ZeroAddress,
                        collateral: ctx.collateral,
                        oracle: ctx.oracle,
                        rateContract: ctx.rateContract,
                    }),
                    encodeImmutables(ctx.circuitBreaker.address, ctx.owner.address, ctx.timelock.address),
                    encodeCustom()
                )
            ).to.be.revertedWithCustomError(Pair, "ZeroAddress");
        });

        it("accepts a valid config and stores fees", async function () {
            const data = await loadFixture(deployCore);
            const pair = await deployListedPair(data, {
                asset: data.mockTokens.WETH.target,
                collateral: data.mockTokens.USDC.target,
            });
            expect(await pair.asset()).to.equal(data.mockTokens.WETH.target);
            expect(await pair.collateralContract()).to.equal(data.mockTokens.USDC.target);
            expect(await pair.cleanLiquidationFee()).to.equal(10000n);
            expect(await pair.dirtyLiquidationFee()).to.equal(9000n);
            expect(await pair.protocolLiquidationFee()).to.equal(1000n);
        });

        it("prices one share using pair decimals, not a hardcoded 1e18", async function () {
            const data = await loadFixture(deployCore);
            const wethPair = await deployListedPair(data, {
                asset: data.mockTokens.WETH.target,
                collateral: data.mockTokens.USDC.target,
            });
            const usdcPair = await deployListedPair(data, {
                asset: data.mockTokens.USDC.target,
                collateral: data.mockTokens.WETH.target,
            });
            expect(await wethPair.decimals()).to.equal(18n);
            expect(await usdcPair.decimals()).to.equal(6n);
            expect(await wethPair.pricePerShare()).to.equal(10n ** 18n);
            expect(await usdcPair.pricePerShare()).to.equal(10n ** 6n);
        });

        it("rejects a zero swapper", async function () {
            const data = await loadFixture(deployCore);
            const pair = await deployListedPair(data, {
                asset: data.mockTokens.WETH.target,
                collateral: data.mockTokens.USDC.target,
            });
            const owner = await impersonate(await pair.owner());
            await expect(pair.connect(owner).setSwapper(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
                pair,
                "ZeroAddress"
            );
        });
    });

    describe("ISO-02 seed configuration", function () {
        it("exposes amountToSeed and per-asset overrides", async function () {
            const data = await loadFixture(deployCore);
            const deployer = data.lightlendPairDeployer;

            expect(await deployer.amountToSeed()).to.equal(0n);

            await deployer.setAmountToSeed(1_000_000n);
            expect(await deployer.amountToSeed()).to.equal(1_000_000n);
            expect(await deployer.seedAmountFor(data.mockTokens.WETH.target)).to.equal(1_000_000n);

            await deployer.setSeedAmount(data.mockTokens.WETH.target, 5n * 10n ** 17n);
            expect(await deployer.seedAmount(data.mockTokens.WETH.target)).to.equal(5n * 10n ** 17n);
            expect(await deployer.seedAmountFor(data.mockTokens.WETH.target)).to.equal(5n * 10n ** 17n);
            expect(await deployer.seedAmountFor(data.mockTokens.USDC.target)).to.equal(1_000_000n);

            await expect(deployer.setAmountToSeed(0)).to.be.revertedWithCustomError(deployer, "InvalidSeedAmount");
            await expect(deployer.setSeedAmount(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
                deployer,
                "ZeroAddress"
            );
        });
    });

    describe("ISO-03 emergency pause", function () {
        it("freezes borrow/deposit/withdraw/interest but leaves repay and liquidation enabled", async function () {
            const data = await loadFixture(deployCore);
            const pair = await deployListedPair(data, {
                asset: data.mockTokens.WETH.target,
                collateral: data.mockTokens.USDC.target,
            });
            const breaker = await impersonate(await pair.circuitBreakerAddress());
            await pair.connect(breaker).pause();

            expect(await pair.borrowLimit()).to.equal(0n);
            expect(await pair.depositLimit()).to.equal(0n);
            expect(await pair.isWithdrawPaused()).to.equal(true);
            expect(await pair.isInterestPaused()).to.equal(true);
            expect(await pair.isRepayPaused()).to.equal(false);
            expect(await pair.isLiquidatePaused()).to.equal(false);

            const owner = await impersonate(await pair.owner());
            await pair.connect(owner).unpause();
            expect(await pair.borrowLimit()).to.equal(ethers.MaxUint256);
            expect(await pair.isWithdrawPaused()).to.equal(false);
            expect(await pair.isRepayPaused()).to.equal(false);
            expect(await pair.isLiquidatePaused()).to.equal(false);
        });

        it("keeps an exploit-specific liquidation pause across emergency unpause", async function () {
            const data = await loadFixture(deployCore);
            const pair = await deployListedPair(data, {
                asset: data.mockTokens.WETH.target,
                collateral: data.mockTokens.USDC.target,
            });
            const breaker = await impersonate(await pair.circuitBreakerAddress());
            await pair.connect(breaker).pauseLiquidate(true);
            expect(await pair.isLiquidatePaused()).to.equal(true);

            await pair.connect(breaker).pause();
            const owner = await impersonate(await pair.owner());
            await pair.connect(owner).unpause();

            expect(await pair.isLiquidatePaused()).to.equal(true);
            expect(await pair.isRepayPaused()).to.equal(false);
        });

        it("still allows repayment after emergency pause on a live pair", async function () {
            const data = await loadFixture(deployCore);
            await data.mockTokens.WETH.mint(data.lightlendPairDeployer.target, ethers.parseUnits("1", 18));
            const pairAddress = await setup.deployPair({
                lightlendPairRegistry: data.lightlendPairRegistry.target,
                lightlendPairDeployerAddress: data.lightlendPairDeployer.target,
                assetTokenAddress: data.mockTokens.WETH.target,
                collateralTokenAddress: data.mockTokens.USDC.target,
                interestRateAddress: data.interestRate.target,
                oracleAddress: data.oracle.target,
                maxOracleDeviation: "5000",
                fullUtilizationRate: "9500000000",
                maxLTV: "75000",
                cleanLiquidationFee: "10000",
                protocolLiquidationFee: "1000",
            });
            const pair = (await ethers.getContractFactory("LightlendPair")).attach(pairAddress);

            await data.mockTokens.USDC.mint(data.lender, ethers.parseUnits("100", 6));
            await data.mockTokens.USDC.connect(data.lender).approve(pair.target, ethers.MaxUint256);
            await data.mockTokens.WETH.mint(data.lender, ethers.parseUnits("10", 18));
            await data.mockTokens.WETH.connect(data.lender).approve(pair.target, ethers.MaxUint256);

            await pair.connect(data.lender).deposit(ethers.parseUnits("1", 18), data.lender.address);
            await pair.connect(data.lender).addCollateral(ethers.parseUnits("100", 6), data.lender.address);
            await pair.connect(data.lender).borrowAsset(ethers.parseUnits("0.01", 18), 0, data.lender.address);

            const circuitBreaker = await pair.circuitBreakerAddress();
            await ethers.provider.send("hardhat_impersonateAccount", [circuitBreaker]);
            await ethers.provider.send("hardhat_setBalance", [circuitBreaker, "0x1000000000000000000"]);
            const cb = await ethers.getSigner(circuitBreaker);
            await pair.connect(cb).pause();

            expect(await pair.isRepayPaused()).to.equal(false);
            await pair.connect(data.lender).repayAsset(ethers.parseUnits("0.01", 18), data.lender.address);
            expect(await pair.userBorrowShares(data.lender.address)).to.equal(0n);
        });
    });
});
