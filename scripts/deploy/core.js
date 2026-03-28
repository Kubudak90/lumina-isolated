const { ethers } = require("hardhat");
const fs = require("fs")
const path = require("path")

const { verify } = require("../utils/verify")

async function main() {
    const [deployer, , , lender] = await hre.ethers.getSigners();

    const admin = { address: '0x0E61A8fb14f6AC999646212D30b2192cd02080Dd' }

    // console.log(`-------- core contracts deployment started --------`)

    // const Timelock = await ethers.getContractFactory("Timelock");
    // const timelock = await Timelock.deploy(admin.address, 60 * 60 * 24 * 2)
    // console.log(`Timelock deployed to ${timelock.target}`)

    // await verify(timelock.target, [admin.address, 60 * 60 * 24 * 2], null, {
    //     verificationDataDir: null, verificationDataPath: null
    // })
    const timelock = {
      target: '0xCCcCCcCCC4B6CD09594E7c5bF108695F79313115'
    }
    
    const LightlendWhitelist = await ethers.getContractFactory("LightlendWhitelist");
    const lightlendWhitelist = await LightlendWhitelist.deploy();
    await lightlendWhitelist.setLightlendDeployerWhitelist([deployer.address], [true])
    console.log(`LightlendWhitelist deployed to ${lightlendWhitelist.target}`)

    await verify(lightlendWhitelist.target, [deployer.address], null, {
        verificationDataDir: null, verificationDataPath: null
    })

    const initialDeployers = [deployer.address, timelock.target, admin.address]
    const LightlendPairRegistry = await ethers.getContractFactory("LightlendPairRegistry");
    const lightlendPairRegistry = await LightlendPairRegistry.deploy(deployer.address, initialDeployers);
    console.log(`LightlendPairRegistry deployed to ${lightlendPairRegistry.target}`)

    await verify(lightlendPairRegistry.target, [deployer.address, initialDeployers], null, {
        verificationDataDir: null, verificationDataPath: null
    })

    const constructorParams = {
        circuitBreaker: admin.address,
        comptroller: admin.address,
        timelock: timelock.target,
    }
    const LightlendPairDeployer = await ethers.getContractFactory("LightlendPairDeployer");
    const lightlendPairDeployerParams = {
        circuitBreaker: constructorParams.circuitBreaker,
        comptroller: constructorParams.timelock,
        timelock: constructorParams.timelock,
        lightlendWhitelist: lightlendWhitelist.target,
        lightlendPairRegistry: lightlendPairRegistry.target
    }
    const lightlendPairDeployer = await LightlendPairDeployer.deploy(lightlendPairDeployerParams);
    console.log(`LightlendPairDeployer deployed to ${lightlendPairDeployer.target}`)

    await verify(lightlendPairDeployer.target, [lightlendPairDeployerParams], null, {
        verificationDataDir: null, verificationDataPath: null
    })

    //set deployer contract as deployer in pairRegistry
    await lightlendPairRegistry.setDeployers([lightlendPairDeployer.target], [true])

    //set pair creation code
    const pairArtifacts = JSON.parse(fs.readFileSync(path.join(__dirname + "../../../artifacts/contracts/LightlendPair.sol/LightlendPair.json")))
    await lightlendPairDeployer.setCreationCode(pairArtifacts.bytecode)
    console.log(`LightlendPair creation code set`)

    const deploymentData = {
        lightlendWhitelist: lightlendWhitelist.target,
        lightlendPairRegistry: lightlendPairRegistry.target,
        lightlendPairDeployer: lightlendPairDeployer.target,
        params: {
            lightlendPairRegistry: {
                owner: deployer.address,
                initialDeployers: initialDeployers
            },
            lightlendPairDeployer: lightlendPairDeployerParams
        },
        timelock: timelock.target
    }
    console.log(`-------- core contracts deployment completed --------`)

    return {
        deployer: deployer, lender: lender,
        timelock: timelock,
        lightlendWhitelist: lightlendWhitelist,
        lightlendPairRegistry: lightlendPairRegistry,
        lightlendPairDeployer: lightlendPairDeployer,
        extra: deploymentData
    }
}

module.exports.main = main