const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const { verify } = require("./utils/verify");

/**
 * Unified LighterEVM deployment script for Lightlend Isolated Pool contracts.
 *
 * Deploys:
 *   1. Timelock
 *   2. LightlendWhitelist
 *   3. LightlendPairRegistry
 *   4. LightlendPairDeployer  (+ sets creation code)
 *   5. VariableInterestRate
 *   6. First lending pair (USDC / WETH)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-lighter.js --network lighterEvm
 */

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log(`Deploying with account: ${deployer.address}`);
    console.log(`Account balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
    console.log();

    // ================================================================
    //  1. Timelock  (2-day delay)
    // ================================================================
    console.log(`-------- Deploying Timelock --------`);
    const timelockDelay = 60 * 60 * 24 * 2; // 2 days
    const Timelock = await ethers.getContractFactory("Timelock");
    const timelock = await Timelock.deploy(deployer.address, timelockDelay);
    await timelock.waitForDeployment();
    console.log(`Timelock deployed to ${timelock.target}`);

    await verify(timelock.target, [deployer.address, timelockDelay], null, {
        verificationDataDir: null,
        verificationDataPath: null,
    });

    // ================================================================
    //  2. LightlendWhitelist
    // ================================================================
    console.log(`-------- Deploying LightlendWhitelist --------`);
    const LightlendWhitelist = await ethers.getContractFactory("LightlendWhitelist");
    const lightlendWhitelist = await LightlendWhitelist.deploy();
    await lightlendWhitelist.waitForDeployment();
    console.log(`LightlendWhitelist deployed to ${lightlendWhitelist.target}`);

    await lightlendWhitelist.setLightlendDeployerWhitelist([deployer.address], [true]);
    console.log(`Deployer whitelisted`);

    await verify(lightlendWhitelist.target, [deployer.address], null, {
        verificationDataDir: null,
        verificationDataPath: null,
    });

    // ================================================================
    //  3. LightlendPairRegistry
    // ================================================================
    console.log(`-------- Deploying LightlendPairRegistry --------`);
    const initialDeployers = [deployer.address, timelock.target];
    const LightlendPairRegistry = await ethers.getContractFactory("LightlendPairRegistry");
    const lightlendPairRegistry = await LightlendPairRegistry.deploy(deployer.address, initialDeployers);
    await lightlendPairRegistry.waitForDeployment();
    console.log(`LightlendPairRegistry deployed to ${lightlendPairRegistry.target}`);

    await verify(lightlendPairRegistry.target, [deployer.address, initialDeployers], null, {
        verificationDataDir: null,
        verificationDataPath: null,
    });

    // ================================================================
    //  4. LightlendPairDeployer
    // ================================================================
    console.log(`-------- Deploying LightlendPairDeployer --------`);
    const lightlendPairDeployerParams = {
        circuitBreaker: deployer.address,
        comptroller: timelock.target,
        timelock: timelock.target,
        lightlendWhitelist: lightlendWhitelist.target,
        lightlendPairRegistry: lightlendPairRegistry.target,
    };
    const LightlendPairDeployer = await ethers.getContractFactory("LightlendPairDeployer");
    const lightlendPairDeployer = await LightlendPairDeployer.deploy(lightlendPairDeployerParams);
    await lightlendPairDeployer.waitForDeployment();
    console.log(`LightlendPairDeployer deployed to ${lightlendPairDeployer.target}`);

    await verify(lightlendPairDeployer.target, [lightlendPairDeployerParams], null, {
        verificationDataDir: null,
        verificationDataPath: null,
    });

    // Register the deployer contract in the pair registry
    await lightlendPairRegistry.setDeployers([lightlendPairDeployer.target], [true]);
    console.log(`LightlendPairDeployer registered in PairRegistry`);

    // ================================================================
    //  4b. Set LightlendPair creation code
    // ================================================================
    console.log(`-------- Setting LightlendPair creation code --------`);
    const pairArtifactPath = path.join(__dirname, "../artifacts/contracts/LightlendPair.sol/LightlendPair.json");
    const pairArtifacts = JSON.parse(fs.readFileSync(pairArtifactPath));
    await lightlendPairDeployer.setCreationCode(pairArtifacts.bytecode);
    console.log(`LightlendPair creation code set`);

    // ================================================================
    //  5. VariableInterestRate
    // ================================================================
    console.log(`-------- Deploying VariableInterestRate --------`);
    const interestRateConfig = {
        suffix: "0.1-10-100 | 3.2% | 1 day | 50%-75% | 80%",
        vertexUtilization: "80000",              // 80%
        vertexRatePercentOfDelta: "30824000000000000",
        minUtil: "50000",                         // 50%
        maxUtil: "75000",                         // 75%
        zeroUtilizationRate: "31890000",          // ~0.1% APR
        minFullUtilizationRate: "3189000000",     // ~10% APR
        maxFullUtilizationRate: "31890000000",    // ~100% APR
        rateHalfLife: "86400",                    // 1 day
    };
    const VariableInterestRate = await ethers.getContractFactory("VariableInterestRate");
    const interestRate = await VariableInterestRate.deploy(
        interestRateConfig.suffix,
        interestRateConfig.vertexUtilization,
        interestRateConfig.vertexRatePercentOfDelta,
        interestRateConfig.minUtil,
        interestRateConfig.maxUtil,
        interestRateConfig.zeroUtilizationRate,
        interestRateConfig.minFullUtilizationRate,
        interestRateConfig.maxFullUtilizationRate,
        interestRateConfig.rateHalfLife
    );
    await interestRate.waitForDeployment();
    console.log(`VariableInterestRate deployed to ${interestRate.target}`);

    await verify(
        interestRate.target,
        [
            interestRateConfig.suffix,
            interestRateConfig.vertexUtilization,
            interestRateConfig.vertexRatePercentOfDelta,
            interestRateConfig.minUtil,
            interestRateConfig.maxUtil,
            interestRateConfig.zeroUtilizationRate,
            interestRateConfig.minFullUtilizationRate,
            interestRateConfig.maxFullUtilizationRate,
            interestRateConfig.rateHalfLife,
        ],
        null,
        { verificationDataDir: null, verificationDataPath: null }
    );

    // ================================================================
    //  6. Deploy first pair: USDC / WETH
    // ================================================================
    console.log(`-------- Deploying USDC/WETH Pair --------`);

    // LighterEVM token addresses (update these to the actual addresses on LighterEVM)
    const USDC_ADDRESS = "0x0000000000000000000000000000000000000001"; // TODO: replace with actual USDC on LighterEVM
    const WETH_ADDRESS = "0x0000000000000000000000000000000000000002"; // TODO: replace with actual WETH on LighterEVM
    const ORACLE_ADDRESS = "0x0000000000000000000000000000000000000003"; // TODO: replace with actual oracle on LighterEVM

    const pairConfig = {
        assetTokenAddress: USDC_ADDRESS,
        collateralTokenAddress: WETH_ADDRESS,
        oracleAddress: ORACLE_ADDRESS,
        maxOracleDeviation: "5000",         // 5%
        interestRateAddress: interestRate.target,
        fullUtilizationRate: "3189000000",  // ~10% starting APR
        maxLTV: "80000",                    // 80%
        cleanLiquidationFee: "10000",       // 10%
        protocolLiquidationFee: "10000",    // 10%
    };

    const LightlendPairDeployerForPair = await ethers.getContractFactory("LightlendPairDeployer");
    const pairDeployerAttached = LightlendPairDeployerForPair.attach(lightlendPairDeployer.target);

    await pairDeployerAttached.setAmountToSeed("1000000");

    const abiEncoder = new ethers.AbiCoder();
    const configData = abiEncoder.encode(
        [
            "address", "address",
            "address", "uint32",
            "address", "uint64",
            "uint256",
            "uint256", "uint256",
        ],
        [
            pairConfig.assetTokenAddress,
            pairConfig.collateralTokenAddress,
            pairConfig.oracleAddress,
            pairConfig.maxOracleDeviation,
            pairConfig.interestRateAddress,
            pairConfig.fullUtilizationRate,
            pairConfig.maxLTV,
            pairConfig.cleanLiquidationFee,
            pairConfig.protocolLiquidationFee,
        ]
    );
    await pairDeployerAttached.deploy(configData);

    const PairRegistry = await ethers.getContractFactory("LightlendPairRegistry");
    const pairRegistry = PairRegistry.attach(lightlendPairRegistry.target);
    const newPairIndex = await pairRegistry.deployedPairsLength();
    const newPairAddress = await pairRegistry.deployedPairsArray(Number(newPairIndex) - 1);
    console.log(`USDC/WETH Pair deployed to ${newPairAddress}`);

    await verify(newPairAddress, [configData], null, {
        verificationDataDir: null,
        verificationDataPath: null,
    });

    // ================================================================
    //  Summary
    // ================================================================
    const deploymentSummary = {
        network: "lighterEvm",
        deployer: deployer.address,
        timelock: timelock.target,
        lightlendWhitelist: lightlendWhitelist.target,
        lightlendPairRegistry: lightlendPairRegistry.target,
        lightlendPairDeployer: lightlendPairDeployer.target,
        variableInterestRate: interestRate.target,
        pairs: {
            "USDC/WETH": newPairAddress,
        },
        config: {
            timelockDelay: timelockDelay,
            interestRate: interestRateConfig,
            pair: pairConfig,
        },
    };

    console.log();
    console.log(`======== Deployment Summary ========`);
    console.log(JSON.stringify(deploymentSummary, null, 2));

    // Write deployment data to file
    const outputDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPath = path.join(outputDir, "lighterEvm.json");
    fs.writeFileSync(outputPath, JSON.stringify(deploymentSummary, null, 2));
    console.log(`Deployment data saved to ${outputPath}`);

    console.log(`======== Deployment Complete ========`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
