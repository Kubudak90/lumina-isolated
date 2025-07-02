const deployCoreScript = require("./deploy/core")
const deployPairScript = require("./deploy/pair")
const deployInterestRateScript = require("./deploy/interestRate")
const deployOracleScript = require("./deploy/oracle")

const { verify } = require("./utils/verify")

main()

async function main(){
    const [deployer, admin] = await hre.ethers.getSigners();

    // const Timelock = await ethers.getContractFactory("UiDataProviderIsolated");
    // const timelock = await Timelock.deploy()
    // console.log(timelock)

    // console.log(await deployCoreScript.main())

    // const oracleConfig = {
    //     baseToken: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", //asset USDT0
    //     quoteToken: "0x1359b05241cA5076c9F59605214f4F84114c0dE8", //collateral wHLP
    //     chainlinkMultiplyAddress: '0x5d5EE47c6bCf6B05B2a3F65c4e37312Dc978d30D', //USDT0 provider
    //     chainlinkDivideAddress: '0xab7A63378Da1a55271262E6ce057F61E916F4014', //collateral provider
    //     maxOracleDelay: "86400",
    //     timelockAddress: "0xCCcCCcCCC4B6CD09594E7c5bF108695F79313115",
    //     name: "Chainlink/Native-USDT0-wHLP"
    // }
    // let { oracle } = await deployOracleScript.main(oracleConfig)
    // console.log(oracle)
    // console.log(await oracle.getPrices())
    // console.log(await oracle.decimals())

    // const pair = await ethers.getContractAt("HyperlendPair", "0xbb727Bce50C12c9472Bf5d6F0e76388455ec62d5")
    // // console.log(await pair.exchangeRateInfo())
    // const oracle = await ethers.getContractAt("OracleChainlink", "0x9A414698155452234ce8e3990BB8DBEdD49ef9Cd")
    // console.log(await oracle.getPrices())
    // console.log(await oracle.decimals())
    //     // console.log(`baseToken`, await oracle.BASE_TOKEN())
    // console.log(`quoteToken`, await oracle.QUOTE_TOKEN())

    // console.log(`CHAINLINK_MULTIPLY_ADDRESS`, await oracle.CHAINLINK_MULTIPLY_ADDRESS())
    // console.log(`CHAINLINK_DIVIDE_ADDRESS`, await oracle.CHAINLINK_DIVIDE_ADDRESS())

    // const timelock = await ethers.getContractAt("Timelock", "0x33e99304C3F628067Bb0939b21820d7Ba39913AB")
    // const eta = parseFloat((new Date().getTime() / 1000) + 172800 + 10).toFixed(0)
    // console.log(await timelock.connect(admin).executeTransaction(
    //     "0xbb727Bce50C12c9472Bf5d6F0e76388455ec62d5",
    //     0,
    //     "setOracle(address,uint32)",
    //     "0x0000000000000000000000009a414698155452234ce8e3990bb8dbedd49ef9cd0000000000000000000000000000000000000000000000000000000000001388",
    //     "1737728752" //after Jan 24 2025 15:25:52 GMT+0100
    // ))
    // console.log(eta)
    
    // // const eta = parseFloat((new Date().getTime() / 1000) + 172800 + 10).toFixed(0)
    // console.log(await timelock.connect(admin).executeTransaction(
    //     "0x0B37927864EFcEf9829B62cca4C9dC9453C51EA2",
    //     0,
    //     "setOracle(address,uint32)",
    //     "0x000000000000000000000000a4c7ea7164d0e38868fd01f252eb463c734b27a20000000000000000000000000000000000000000000000000000000000001388",
    //     '1734868072'
    // ))
    // console.log(eta)

    // const interestRateConfig = {
    //     suffix: "0.1-10-100 | 3.2% | 1 day | 50%-75% | 80%", //zeroUtil-minFullUtil-maxFullUtil | vertexUtil | half life | minUtil-maxUtil | vertexUtil
    //     vertexUtilization: "80000", //80%
    //     vertexRatePercentOfDelta: '30824000000000000', //"200000000000000000",
    //     minUtil: "50000", //50%
    //     maxUtil: "75000", //75%
    //     zeroUtilizationRate: "31890000", //~0.1% APR
    //     minFullUtilizationRate: "3189000000", //~10%
    //     maxFullUtilizationRate: "31890000000", //~100% APR
    //     rateHalfLife: "86400" //1 day
    // }
    // let interestRate = await deployInterestRateScript.main(interestRateConfig)
    // console.log(interestRate)

    let pairConfig = {
        hyperlendPairRegistry: "0xf55AF86c9EC3a7d5fa6367c00a120E6B262f718d",
        hyperlendPairDeployerAddress: "0xD5B33d3c6e750A51fd4E90dbf4AFa2586E33d02c",
        assetTokenAddress: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", //borrow WETH
        collateralTokenAddress: "0x1359b05241cA5076c9F59605214f4F84114c0dE8", //supply MBTC as collateral
        interestRateAddress: '0x02CA3a21136715A7a06B45DF24383B18A56aF931',
        oracleAddress: '0xE0d0528707a5dc63329EC4993f58E35D77AE4eD0',
        maxOracleDeviation: "5000", //5%
        fullUtilizationRate: "3189000000", //~10% start APR
        maxLTV: "83000", //83%
        cleanLiquidationFee: "10000", //10%
        protocolLiquidationFee: "10000" //10% of the liquidator's fee
    }
    console.log(await deployPairScript.main(pairConfig))
}
