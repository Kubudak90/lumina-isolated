// SPDX-License-Identifier: ISC
pragma solidity ^0.8.19;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Strings} from '@openzeppelin/contracts/utils/Strings.sol';
import {SSTORE2} from '@rari-capital/solmate/src/utils/SSTORE2.sol';
import {BytesLib} from 'solidity-bytes-utils/contracts/BytesLib.sol';
import {ILightlendWhitelist} from './interfaces/ILightlendWhitelist.sol';
import {ILightlendPair} from './interfaces/ILightlendPair.sol';
import {ILightlendPairRegistry} from './interfaces/ILightlendPairRegistry.sol';
import {SafeERC20} from './libraries/SafeERC20.sol';
import {LightlendPairValidation} from './libraries/LightlendPairValidation.sol';

// solhint-disable no-inline-assembly

struct ConstructorParams {
    address circuitBreaker;
    address comptroller;
    address timelock;
    address lightlendWhitelist;
    address lightlendPairRegistry;
}

/// @title LightlendPairDeployer
/// @notice Deploys and initializes new LightlendPairs
/// @dev Uses create2 to deploy the pairs, logs an event, and records a list of all deployed pairs
contract LightlendPairDeployer is Ownable {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    // Storage
    address public contractAddress1;
    address public contractAddress2;

    // Admin contracts
    address public circuitBreakerAddress;
    address public comptrollerAddress;
    address public timelockAddress;
    address public lightlendPairRegistryAddress;
    address public lightlendWhitelistAddress;

    // Default swappers
    address[] public defaultSwappers;

    /// @notice Default seed amount when no per-asset override is set. Public so the admin UI can read it.
    uint256 public amountToSeed;

    /// @notice Optional per-asset seed override. Non-zero values take precedence over `amountToSeed`.
    mapping(address => uint256) public seedAmount;

    constructor(ConstructorParams memory _params) Ownable() {
        LightlendPairValidation.validateNonZero(_params.circuitBreaker);
        LightlendPairValidation.validateNonZero(_params.comptroller);
        LightlendPairValidation.validateNonZero(_params.timelock);
        LightlendPairValidation.validateNonZero(_params.lightlendWhitelist);
        LightlendPairValidation.validateNonZero(_params.lightlendPairRegistry);
        circuitBreakerAddress = _params.circuitBreaker;
        comptrollerAddress = _params.comptroller;
        timelockAddress = _params.timelock;
        lightlendWhitelistAddress = _params.lightlendWhitelist;
        lightlendPairRegistryAddress = _params.lightlendPairRegistry;
    }
    /// @notice The ```LogDeploy``` event is emitted when a new Pair is deployed
    /// @param address_ The address of the pair
    /// @param asset The address of the Asset Token contract
    /// @param collateral The address of the Collateral Token contract
    /// @param name The name of the Pair
    /// @param configData The config data of the Pair
    /// @param immutables The immutables of the Pair
    /// @param customConfigData The custom config data of the Pair
    event LogDeploy(
        address indexed address_,
        address indexed asset,
        address indexed collateral,
        string name,
        bytes configData,
        bytes immutables,
        bytes customConfigData
    );

    /// @notice List of the names of all deployed Pairs
    address[] public deployedPairsArray;

    function version() external pure returns (uint256 _major, uint256 _minor, uint256 _patch) {
        return (5, 0, 0);
    }

    // ============================================================================================
    // Functions: View Functions
    // ============================================================================================

    /// @notice The ```deployedPairsLength``` function returns the length of the deployedPairsArray
    /// @return length of array
    function deployedPairsLength() external view returns (uint256) {
        return deployedPairsArray.length;
    }

    /// @notice The ```getAllPairAddresses``` function returns all pair addresses in deployedPairsArray
    /// @return _deployedPairs memory All deployed pair addresses
    function getAllPairAddresses() external view returns (address[] memory _deployedPairs) {
        _deployedPairs = deployedPairsArray;
    }

    function getNextNameSymbol(
        address _asset,
        address _collateral
    ) public view returns (string memory _name, string memory _symbol) {
        _name = string(
            abi.encodePacked(
                'Lightlend Interest Bearing ',
                IERC20(_asset).safeSymbol(),
                ' (',
                IERC20(_collateral).safeName(),
                ')'
            )
        );
        _symbol = string(
            abi.encodePacked(
                'h',
                IERC20(_asset).safeSymbol(),
                '(',
                IERC20(_collateral).safeSymbol(),
                ')'
            )
        );
    }

    // ============================================================================================
    // Functions: Setters
    // ============================================================================================

    /// @notice The ```setCreationCode``` function sets the bytecode for the lightlendPair
    /// @dev splits the data if necessary to accommodate creation code that is slightly larger than 24kb
    /// @dev creation code must always be larger than 13kb, otherwise it will revert
    /// @param _creationCode The creationCode for the Lightlend Pair
    function setCreationCode(bytes calldata _creationCode) external onlyOwner {
        bytes memory _firstHalf = BytesLib.slice(_creationCode, 0, 13_000);
        contractAddress1 = SSTORE2.write(_firstHalf);
        if (_creationCode.length > 13_000) {
            bytes memory _secondHalf = BytesLib.slice(
                _creationCode,
                13_000,
                _creationCode.length - 13_000
            );
            contractAddress2 = SSTORE2.write(_secondHalf);
        } else {
            contractAddress2 = address(0);
        }
    }

    /// @notice The ```setDefaultSwappers``` function is used to set default list of approved swappers
    /// @param _swappers The list of swappers to set as default allowed
    function setDefaultSwappers(address[] memory _swappers) external onlyOwner {
        for (uint256 i = 0; i < _swappers.length; i++) {
            LightlendPairValidation.validateNonZero(_swappers[i]);
        }
        defaultSwappers = _swappers;
    }

    /// @notice The ```SetTimelock``` event is emitted when the timelockAddress is set
    /// @param oldAddress The original address
    /// @param newAddress The new address
    event SetTimelock(address oldAddress, address newAddress);

    /// @notice The ```setTimelock``` function sets the timelockAddress
    /// @param _newAddress the new time lock address
    function setTimelock(address _newAddress) external onlyOwner {
        LightlendPairValidation.validateNonZero(_newAddress);
        emit SetTimelock(timelockAddress, _newAddress);
        timelockAddress = _newAddress;
    }

    /// @notice The ```SetRegistry``` event is emitted when the lightlendPairRegistryAddress is set
    /// @param oldAddress The old address
    /// @param newAddress The new address
    event SetRegistry(address oldAddress, address newAddress);

    /// @notice The ```setRegistry``` function sets the lightlendPairRegistryAddress
    /// @param _newAddress The new address
    function setRegistry(address _newAddress) external onlyOwner {
        LightlendPairValidation.validateNonZero(_newAddress);
        emit SetRegistry(lightlendPairRegistryAddress, _newAddress);
        lightlendPairRegistryAddress = _newAddress;
    }

    /// @notice The ```SetComptroller``` event is emitted when the comptrollerAddress is set
    /// @param oldAddress The old address
    /// @param newAddress The new address
    event SetComptroller(address oldAddress, address newAddress);

    /// @notice The ```setComptroller``` function sets the comptrollerAddress
    /// @param _newAddress The new address
    function setComptroller(address _newAddress) external onlyOwner {
        LightlendPairValidation.validateNonZero(_newAddress);
        emit SetComptroller(comptrollerAddress, _newAddress);
        comptrollerAddress = _newAddress;
    }

    /// @notice The ```SetWhitelist``` event is emitted when the lightlendWhitelistAddress is set
    /// @param oldAddress The old address
    /// @param newAddress The new address
    event SetWhitelist(address oldAddress, address newAddress);

    /// @notice The ```setWhitelist``` function sets the lightlendWhitelistAddress
    /// @param _newAddress The new address
    function setWhitelist(address _newAddress) external onlyOwner {
        LightlendPairValidation.validateNonZero(_newAddress);
        emit SetWhitelist(lightlendWhitelistAddress, _newAddress);
        lightlendWhitelistAddress = _newAddress;
    }

    /// @notice The ```SetCircuitBreaker``` event is emitted when the circuitBreakerAddress is set
    /// @param oldAddress The old address
    /// @param newAddress The new address
    event SetCircuitBreaker(address oldAddress, address newAddress);

    /// @notice The ```setCircuitBreaker``` function sets the circuitBreakerAddress
    /// @param _newAddress The new address
    function setCircuitBreaker(address _newAddress) external onlyOwner {
        LightlendPairValidation.validateNonZero(_newAddress);
        emit SetCircuitBreaker(circuitBreakerAddress, _newAddress);
        circuitBreakerAddress = _newAddress;
    }

    /// @notice the ```SetAmountToSeed``` event is emitted when the AmountToSeed is set
    /// @param oldAmountToSeed The old amount to seed new pairs
    /// @param newAmountToSeed The new amount to seed new pairs
    event SetAmountToSeed(uint256 oldAmountToSeed, uint256 newAmountToSeed);

    /// @notice the ```setAmountToSeed``` function sets the default amount of asset to seed a pair
    /// @param _amountToSeed The amount of assets to seed the newly created pairs
    function setAmountToSeed(uint256 _amountToSeed) external onlyOwner {
        LightlendPairValidation.validateSeedAmount(_amountToSeed);
        emit SetAmountToSeed(amountToSeed, _amountToSeed);
        amountToSeed = _amountToSeed;
    }

    /// @notice Emitted when a per-asset seed override is set
    event SetSeedAmount(address indexed asset, uint256 oldAmount, uint256 newAmount);

    /// @notice Sets a per-asset seed override. Pass 0 to fall back to `amountToSeed`.
    function setSeedAmount(address _asset, uint256 _amount) external onlyOwner {
        LightlendPairValidation.validateNonZero(_asset);
        if (_amount != 0) {
            LightlendPairValidation.validateSeedAmount(_amount);
        }
        emit SetSeedAmount(_asset, seedAmount[_asset], _amount);
        seedAmount[_asset] = _amount;
    }

    /// @notice Effective seed used for a given asset (per-asset override or default).
    function seedAmountFor(address _asset) public view returns (uint256) {
        uint256 perAsset = seedAmount[_asset];
        return perAsset > 0 ? perAsset : amountToSeed;
    }

    // ============================================================================================
    // Functions: Internal Methods
    // ============================================================================================

    /// @notice The ```_deploy``` function is an internal function with deploys the pair
    /// @param _configData abi.encode(address _asset, address _collateral, address _oracle, uint32 _maxOracleDeviation, address _rateContract, uint64 _fullUtilizationRate, uint256 _maxLTV, uint256 _cleanLiquidationFee, uint256 _protocolLiquidationFee). Dirty liquidation fee is derived inside the pair as 90% of the clean fee.
    /// @param _immutables abi.encode(address _circuitBreakerAddress, address _comptrollerAddress, address _timelockAddress)
    /// @param _customConfigData abi.encode(string memory _nameOfContract, string memory _symbolOfContract, uint8 _decimalsOfContract)
    /// @return _pairAddress The address to which the Pair was deployed
    function _deploy(
        bytes memory _configData,
        bytes memory _immutables,
        bytes memory _customConfigData
    ) private returns (address _pairAddress) {
        // Get creation code
        bytes memory _creationCode = SSTORE2.read(contractAddress1);
        if (contractAddress2 != address(0)) {
            _creationCode = BytesLib.concat(_creationCode, SSTORE2.read(contractAddress2));
        }

        // Get bytecode
        bytes memory bytecode = abi.encodePacked(
            _creationCode,
            abi.encode(_configData, _immutables, _customConfigData)
        );

        // Generate salt using constructor params
        bytes32 salt = keccak256(abi.encodePacked(_configData, _immutables, _customConfigData));

        /// @solidity memory-safe-assembly
        assembly {
            _pairAddress := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        if (_pairAddress == address(0)) revert Create2Failed();

        deployedPairsArray.push(_pairAddress);

        // Set additional values for LightlendPair
        ILightlendPair _lightlendPair = ILightlendPair(_pairAddress);
        address[] memory _defaultSwappers = defaultSwappers;
        for (uint256 i = 0; i < _defaultSwappers.length; i++) {
            _lightlendPair.setSwapper(_defaultSwappers[i], true);
        }

        return _pairAddress;
    }

    // ============================================================================================
    // Functions: External Deploy Methods
    // ============================================================================================

    /// @notice The ```deploy``` function allows the deployment of a LightlendPair with default values
    /// @param _configData abi.encode(address _asset, address _collateral, address _oracle, uint32 _maxOracleDeviation, address _rateContract, uint64 _fullUtilizationRate, uint256 _maxLTV, uint256 _cleanLiquidationFee, uint256 _protocolLiquidationFee)
    /// @return _pairAddress The address to which the Pair was deployed
    function deploy(bytes memory _configData) external returns (address _pairAddress) {
        if (
            !ILightlendWhitelist(lightlendWhitelistAddress).lightlendDeployerWhitelist(msg.sender)
        ) {
            revert WhitelistedDeployersOnly();
        }

        (address _asset, address _collateral, , , , , , , ) = abi.decode(
            _configData,
            (address, address, address, uint32, address, uint64, uint256, uint256, uint256)
        );
        LightlendPairValidation.validatePairTokens(_asset, _collateral);

        (string memory _name, string memory _symbol) = getNextNameSymbol(_asset, _collateral);

        bytes memory _immutables = abi.encode(
            circuitBreakerAddress,
            comptrollerAddress,
            timelockAddress
        );
        bytes memory _customConfigData = abi.encode(_name, _symbol, IERC20(_asset).safeDecimals());

        _pairAddress = _deploy(_configData, _immutables, _customConfigData);

        ILightlendPairRegistry(lightlendPairRegistryAddress).addPair(_pairAddress);

        uint256 _seed = seedAmountFor(_asset);
        if (_seed == 0) revert MustSeedPair();
        IERC20(_asset).safeApprove(_pairAddress, _seed);
        ILightlendPair(_pairAddress).deposit(_seed, address(this));

        emit LogDeploy(
            _pairAddress,
            _asset,
            _collateral,
            _name,
            _configData,
            _immutables,
            _customConfigData
        );
    }

    // ============================================================================================
    // Functions: Admin
    // ============================================================================================

    /// @notice The ```globalPause``` function calls the pause() function on a given set of pair addresses
    /// @dev Ignores reverts when calling pause()
    /// @param _addresses Addresses to attempt to pause()
    /// @return _updatedAddresses Addresses for which pause() was successful
    function globalPause(
        address[] memory _addresses
    ) external returns (address[] memory _updatedAddresses) {
        if (msg.sender != circuitBreakerAddress) revert CircuitBreakerOnly();

        address _pairAddress;
        uint256 _lengthOfArray = _addresses.length;
        _updatedAddresses = new address[](_lengthOfArray);
        for (uint256 i = 0; i < _lengthOfArray; ) {
            _pairAddress = _addresses[i];
            try ILightlendPair(_pairAddress).pause() {
                _updatedAddresses[i] = _addresses[i];
            } catch {}
            unchecked {
                i = i + 1;
            }
        }
    }

    // ============================================================================================
    // Errors
    // ============================================================================================

    error CircuitBreakerOnly();
    error WhitelistedDeployersOnly();
    error Create2Failed();
    error MustSeedPair();
    error ZeroAddress();
    error InvalidSeedAmount();
    error AssetEqualsCollateral();
}
