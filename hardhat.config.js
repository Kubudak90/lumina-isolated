require("dotenv").config()
require("@nomicfoundation/hardhat-toolbox");

const mnemonic = process.env.MNEMONIC

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
        lighterEvmTestnet: {
            accounts: {
                mnemonic,
            },
            chainId: 998,
            url: 'https://rpc.hyperliquid-testnet.xyz/evm',
        },
        lighterEvm: {
            accounts: {
                mnemonic,
            },
            chainId: 999,
            url: 'https://rpc.hyperliquid.xyz/evm'
        },
        baseSepolia: {
            accounts: [process.env.DEPLOYER_PRIVATE_KEY],
            chainId: 84532,
            url: 'https://sepolia.base.org'
        }
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
            lighterEvmTestnet: "empty",
            lighterEvm: process.env.ETHERSCAN
        },
        customChains: [
            {
                network: "lighterEvmTestnet",
                chainId: 998,
                urls: {
                    apiURL: "https://explorer.lightlend.finance/api",
                    browserURL: "https://explorer.lightlend.finance"
                }
            },
            {
                network: "lighterEvm",
                chainId: 999,
                urls: {
                    apiURL: "https://api.etherscan.io/v2/api?chainid=999",
                    browserURL: "https://www.hyperscan.com"
                }
            }
        ]
    },
    // sourcify: {
    //     enabled: true,
    //     apiUrl: "https://sourcify.parsec.finance",
    //     browserUrl: "https://purrsec.com/",
    // }
};
