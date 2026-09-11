const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Pair deployer seed configuration", function () {
  it("exposes the configured seed and preserves owner-only updates", async function () {
    const [owner, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("LightlendPairDeployer");
    const deployer = await factory.deploy(Array(5).fill(owner.address));
    await deployer.waitForDeployment();
    expect(await deployer.amountToSeed()).to.equal(0n);
    await deployer.setAmountToSeed(1000000n);
    expect(await deployer.amountToSeed()).to.equal(1000000n);
    await expect(deployer.connect(other).setAmountToSeed(1n)).to.be.reverted;
    expect(await deployer.amountToSeed()).to.equal(1000000n);
  });
});
