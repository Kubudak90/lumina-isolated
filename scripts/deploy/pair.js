const { ethers } = require("hardhat");

const { verify } = require("../utils/verify")

async function main({
    lightlendPairRegistry,
    lightlendPairDeployerAddress,
    assetTokenAddress,
    collateralTokenAddress,
    interestRateAddress,
    oracleAddress,
    maxOracleDeviation = "5000", //5%
    fullUtilizationRate = "9500000000", //
    maxLTV = "75000", //75%
    cleanLiquidationFee = "10000", //10%
    protocolLiquidationFee = "1000" //10% of the liquidator's fee
}) {
    const LightlendPairDeployer = await ethers.getContractFactory("LightlendPairDeployer");
    const lightlendPairDeployer = LightlendPairDeployer.attach(lightlendPairDeployerAddress)

    console.log(await lightlendPairDeployer.setAmountToSeed('1000000'))

    const abiEncoder = new ethers.AbiCoder()
    const configData = abiEncoder.encode(
        [
            'address', 'address', 
            'address', 'uint32',
            'address', 'uint64',
            'uint256',
            'uint256', 'uint256'
        ],
        [
            assetTokenAddress,
            collateralTokenAddress,
            oracleAddress,
            maxOracleDeviation,
            interestRateAddress,
            fullUtilizationRate,
            maxLTV,
            cleanLiquidationFee,
            protocolLiquidationFee
        ]
    );
    await lightlendPairDeployer.deploy(configData)
    // console.log(`Market with asset ${assetTokenAddress} and collateral ${collateralTokenAddress} deployed successfully!`)

    const PairRegistry = await ethers.getContractFactory("LightlendPairRegistry")
    const pairRegistry = PairRegistry.attach(lightlendPairRegistry)

    let newPairIndex = await pairRegistry.deployedPairsLength()
    let newPairAddress = await pairRegistry.deployedPairsArray(Number(newPairIndex)-1)

    await verify(newPairAddress, [configData], null, {
        verificationDataDir: null, verificationDataPath: null
    })

    return newPairAddress;
}

module.exports.main = main