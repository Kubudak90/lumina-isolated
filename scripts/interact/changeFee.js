main()

async function main(){
    const [deployer] = await hre.ethers.getSigners();

    const pair = await ethers.getContractAt("LightlendPair", "0x06Fd9D03b3d0F18E4919919b72D30c582f0a97E5")

    await pair.changeFee('20000')
    console.log(`fee changed`)
}