require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const mnemonic = process.env.MNEMONIC || TEST_MNEMONIC;

function deployerAccounts() {
    const key = process.env.DEPLOYER_PRIVATE_KEY;
    return key ? [key] : [];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    networks: {
        hardhat: {
            gas: "auto",
            accounts: {
                mnemonic,
            },
            chainId: 1337,
        },
        baseSepolia: {
            accounts: deployerAccounts(),
            chainId: 84532,
            url: "https://sepolia.base.org",
        },
    },
    paths: {
        artifacts: "./artifacts",
        cache: "./cache",
        sources: "./contracts",
        tests: "./test",
    },
    solidity: {
        compilers: [
            {
                version: "0.8.20",
                settings: {
                    evmVersion: "shanghai",
                    viaIR: true,
                    debug: {
                        revertStrings: "strip",
                    },
                    metadata: {
                        bytecodeHash: "none",
                    },
                    optimizer: {
                        enabled: true,
                        runs: 1,
                    },
                },
            },
        ],
    },
    etherscan: {
        apiKey: {
            baseSepolia: process.env.ETHERSCAN_API_KEY_BASE || process.env.ETHERSCAN || "",
        },
    },
};
