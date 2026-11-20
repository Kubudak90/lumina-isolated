// Lighter EVM devnet isolated deployment (spec 3.1, 3.3 Isolated, 3.4; plan.md S5c and the S5a/S5b
// notes above it; steps/S5c.md). Replaces the retired scripts/deploy-lighter.js (hardcoded chain,
// placeholder addresses, unfunded seed).
//
// The chain, the Safe, the dual oracles and the pair parameters come from the deployment manifest
// (lumina-monorepo `deployments/<env>.json`, read and validated with the monorepo loader
// `deployments/index.mjs`); the values the manifest does not carry (rate calculator, oracle
// deviation bound, starting full-utilization rate) from scripts/lighter/isolated-params.js.
//
//   LUMINA_ISOLATED_PHASE=deploy    (the deployer EOA's part)
//     1. Timelock (admin = Safe, delay = roles.isolated.timelockDelaySec = 2 days), LightlendWhitelist,
//        LightlendPairRegistry (owner = deployer until the handover, no initial deployers),
//        LightlendPairDeployer (circuit breaker = Safe, comptroller = Safe, timelock = Timelock),
//        VariableInterestRate; getNewRate simulated at 0%, the vertex and 100% utilization.
//     2. Pair creation code, the pair deployer as the only registry deployer, the per-asset seed
//        amounts; then both pairs through LightlendPairDeployer.deploy() with the dual oracle of the
//        same asset/collateral order (checked first: plan.md wiring invariant).
//     3. Seeds: the deployer funds the pair deployer contract with each pair's seed, and deploy()
//        creates, registers and seeds the pair in one transaction (the seed shares stay with the
//        pair deployer contract, which cannot redeem them).
//     4. Handover, deployer side: the deployer leaves the whitelist, transfers the whitelist and
//        registry ownership to the Safe (Ownable2Step: pending until the Safe accepts) and the pair
//        deployer ownership (Ownable: immediate). Pairs are owned by the Safe from construction
//        (comptroller), so the deployer never owns a pair.
//     Then the Safe (lumina-monorepo harness/lib/safe.mjs execSafeTx, outside this script) accepts
//     the whitelist and registry ownership and calls revokeDeployerSwapperAccess() on each pair.
//   LUMINA_ISOLATED_PHASE=finalize  (no transaction)
//     5. Every isolated role is read from the chain and compared with the decision-3 layout (Safe /
//        Timelock, nothing pending, deployer and bots without deploy rights, swapper access revoked);
//        only then are the observed holders written to `roles.isolated`.
//
// Usage (the chain comes from the manifest; the RPC URL from the env var the manifest names):
//   LUMINA_ISOLATED_PHASE=deploy LUMINA_MANIFEST=/path/manifest.json \
//   LUMINA_DEPLOY_CHECKPOINT=/path/deploy-checkpoint.json LIGHTER_DEVNET_RPC_URL=... \
//     npx hardhat run scripts/deploy-lighter-isolated.js --network lighterDevnet
// Optional:
//   LUMINA_MANIFEST_LOADER  path to deployments/index.mjs (default: the monorepo submodule layout)
//   LUMINA_ALLOW_DIRTY=true deploy from a checkout with uncommitted changes (local iteration only)
//
// Safe check: before any transaction (the Timelock, the pair deployer and the pairs name the Safe
// from construction) the Safe must match the manifest (code, owners, threshold, singleton, fallback
// handler, VERSION, no module, no guard), and the S4c Safe probe recorded in the deploy checkpoint
// (`safeProbe`: a real 2-of-3 queue and cancel on the Executor) must verify on-chain.
//
// Signing: every transaction is sent from `manifest.deployer` through the network's accounts (an
// unlocked anvil account on the local harness; S12 needs a signer for the deployer key).
//
// Idempotent per manifest entry: a contract with a manifest entry is checked (code, codehash) and
// reused; a pair created by an interrupted run is found through the pair deployer and adopted; every
// configuration and handover call is sent only when the chain still needs it. A run that sends
// nothing leaves the manifest byte-identical. A run that sends continues only from the
// lumina-isolated commit the manifest records (or records HEAD when none is), from a clean checkout.
// Every change is verified on-chain (receipt, code, codehash, read-back wiring and parameters)
// before the manifest is written (validated, temp file + rename); pair parameters are written from
// on-chain reads.
// Gas: every transaction is dry-run first (estimate, then eth_call with the exact limit); its
// explicit limit is the estimate + 25%, refused above the EIP-7825 per-tx cap (and the block limit).

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const P = require("./lighter/isolated-params");

const { ethers } = hre;

const TX_GAS_CAP = 16_777_216n; // EIP-7825 (Fusaka) per-transaction gas cap, 2^24
const GAS_BUFFER_PERCENT = 25n;
const REPO = "lumina-isolated";
const PHASES = ["deploy", "finalize"];
const ZERO = ethers.ZeroAddress;
const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const SAFE_FALLBACK_HANDLER_SLOT = ethers.id("fallback_manager.handler.address");
const SAFE_GUARD_SLOT = ethers.id("guard_manager.guard.address");

/** The two pairs (spec 3.1): manifest contract key, market name, dual oracle contract key. */
const PAIRS = [
  { key: "pairUsdcWeth", name: "USDC/WETH", asset: "USDC", collateral: "WETH", dualKey: "dualOracleUsdcWeth" },
  { key: "pairWethUsdc", name: "WETH/USDC", asset: "WETH", collateral: "USDC", dualKey: "dualOracleWethUsdc" },
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
];
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function VERSION() view returns (string)",
];
const DUAL_ORACLE_ABI = [
  "function ASSET() view returns (address)",
  "function COLLATERAL() view returns (address)",
  "function ASSET_PRICE_SOURCE() view returns (address)",
  "function COLLATERAL_PRICE_SOURCE() view returns (address)",
  "function GUARD() view returns (address)",
  "function getPrices() view returns (bool isBadData, uint256 priceLow, uint256 priceHigh)",
];
const EXECUTOR_EVENTS = [
  "event QueueTransaction(bytes32 indexed txHash, address indexed target, bytes32 codehash, bytes data, uint256 eta)",
  "event CancelTransaction(bytes32 indexed txHash, address indexed target, bytes data, uint256 eta)",
];
const SAFE_EXECUTION_SUCCESS = ethers.id("ExecutionSuccess(bytes32,uint256)");

function fail(message) {
  throw new Error(`deploy-lighter-isolated: ${message}`);
}

function eq(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

async function loadLoader() {
  const loaderPath = process.env.LUMINA_MANIFEST_LOADER || path.resolve(__dirname, "../../../deployments/index.mjs");
  if (!fs.existsSync(loaderPath)) fail(`manifest loader not found at ${loaderPath} (set LUMINA_MANIFEST_LOADER)`);
  return import(pathToFileURL(loaderPath).href);
}

function git(args) {
  return execFileSync("git", args, { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim();
}

function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

class ManifestFile {
  constructor(loader, file) {
    this.loader = loader;
    this.file = file;
    this.text = fs.readFileSync(file, "utf8");
    this.data = JSON.parse(this.text);
    // Validate the file as it is (template or deployed) through the shared loader.
    this.loader.loadManifest({ env: this.data.environment, path: file, strict: false });
  }

  /** Validates and writes atomically, only if something changed (a no-op run leaves the bytes). */
  save() {
    const text = serialize(this.data);
    if (text === this.text) return false;
    this.loader.validateManifest(this.data, { strict: false });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
    this.text = text;
    return true;
  }
}

async function codeOf(address) {
  return address ? ethers.provider.getCode(address) : "0x";
}

async function boundedGas(estimate) {
  const block = await ethers.provider.getBlock("latest");
  const cap = block.gasLimit < TX_GAS_CAP ? block.gasLimit : TX_GAS_CAP;
  if (estimate > cap) fail(`gas estimate ${estimate} exceeds the per-transaction cap ${cap}; split the step`);
  const buffered = estimate + (estimate * GAS_BUFFER_PERCENT) / 100n;
  return buffered > cap ? cap : buffered;
}

function sameSet(a, b) {
  const x = a.map((v) => v.toLowerCase()).sort();
  const y = b.map((v) => v.toLowerCase()).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function slotAddress(word) {
  return ethers.getAddress(`0x${word.slice(2).padStart(64, "0").slice(24)}`);
}

/**
 * The Safe must be the one the manifest describes and must have proven a real 2-of-3 transaction
 * (the S4c probe in the deploy checkpoint) before anything names it as owner or admin.
 */
async function checkSafe(m) {
  const safe = m.safe.address;
  if (!safe || (await codeOf(safe)) === "0x") fail("safe.address must be set and hold code (the core deploy creates the Safe)");
  const s = new ethers.Contract(safe, SAFE_ABI, ethers.provider);
  if (!sameSet(await s.getOwners(), m.safe.owners)) fail(`Safe ${safe}: owners differ from safe.owners`);
  if (Number(await s.getThreshold()) !== m.safe.threshold) fail(`Safe ${safe}: threshold is not ${m.safe.threshold}`);
  const [modules] = await s.getModulesPaginated(SAFE_SENTINEL, 16);
  if (modules.length) fail(`Safe ${safe}: has module(s) ${modules.join(", ")}`);
  if (BigInt(await ethers.provider.getStorage(safe, SAFE_GUARD_SLOT)) !== 0n) fail(`Safe ${safe}: a transaction guard is set`);
  const singleton = slotAddress(await ethers.provider.getStorage(safe, 0));
  if (!eq(singleton, m.safe.singleton)) fail(`Safe ${safe}: singleton ${singleton} != safe.singleton ${m.safe.singleton}`);
  const handler = slotAddress(await ethers.provider.getStorage(safe, SAFE_FALLBACK_HANDLER_SLOT));
  if (!eq(handler, m.safe.fallbackHandler)) fail(`Safe ${safe}: fallback handler ${handler} != safe.fallbackHandler`);
  const version = await new ethers.Contract(m.safe.singleton, SAFE_ABI, ethers.provider).VERSION();
  if (version !== m.safe.version) fail(`Safe ${safe}: singleton VERSION ${version} != safe.version ${m.safe.version}`);

  const checkpointPath = process.env.LUMINA_DEPLOY_CHECKPOINT;
  if (!checkpointPath || !fs.existsSync(checkpointPath)) fail("set LUMINA_DEPLOY_CHECKPOINT to the deploy checkpoint with the S4c Safe probe");
  const probe = JSON.parse(fs.readFileSync(checkpointPath, "utf8")).safeProbe;
  const executor = m.contracts.executor?.address;
  if (!probe || !eq(probe.safe, safe) || !eq(probe.executor, executor)) fail("no Safe probe for this Safe and Executor in the deploy checkpoint (run the core deploy first)");
  const iface = new ethers.Interface(EXECUTOR_EVENTS);
  for (const [hash, eventName] of [[probe.queueTx, "QueueTransaction"], [probe.cancelTx, "CancelTransaction"]]) {
    const r = await ethers.provider.getTransactionReceipt(hash);
    if (!r || r.status !== 1 || !eq(r.to, safe)) fail(`Safe probe ${eventName} tx ${hash}: not mined, failed, or not sent to the Safe`);
    if (!r.logs.some((l) => eq(l.address, safe) && l.topics[0] === SAFE_EXECUTION_SUCCESS)) fail(`Safe probe ${eventName} tx ${hash}: no ExecutionSuccess`);
    const ev = r.logs.filter((l) => eq(l.address, executor)).map((l) => iface.parseLog(l)).find((e) => e?.name === eventName);
    if (!ev || ev.args.txHash !== probe.action) fail(`Safe probe ${eventName} tx ${hash}: no Executor ${eventName} for the probe action`);
  }
  return safe;
}

async function main() {
  const phase = process.env.LUMINA_ISOLATED_PHASE;
  if (!PHASES.includes(phase)) fail(`set LUMINA_ISOLATED_PHASE to one of ${PHASES.join(", ")}`);
  const manifestPath = process.env.LUMINA_MANIFEST;
  if (!manifestPath) fail("set LUMINA_MANIFEST to the manifest path");
  const loader = await loadLoader();
  const mf = new ManifestFile(loader, path.resolve(manifestPath));
  const m = mf.data;

  // ---- chain: from the manifest, refused on mismatch
  const network = await ethers.provider.getNetwork();
  if (BigInt(m.chainId) !== network.chainId) fail(`manifest chainId ${m.chainId} != RPC chain ${network.chainId} (network ${hre.network.name})`);
  console.log(`deploy-lighter-isolated (${phase}): ${m.environment} (chain ${m.chainId}), manifest ${mf.file}`);

  // ---- inputs from the core and oracle deploys
  const WETH = m.assets.WETH.address;
  const USDC = m.assets.USDC.address;
  const tokenOf = { WETH, USDC };
  const delay = m.roles.isolated.timelockDelaySec;
  if (delay !== 2 * 24 * 3600) fail(`roles.isolated.timelockDelaySec must be 172800 (2 days), got ${delay}`);
  for (const key of ["executor", "priceGuard", ...PAIRS.map((p) => p.dualKey)]) {
    const e = m.contracts[key];
    if (!e?.address) fail(`contracts.${key} must be deployed first (core and oracle deploy)`);
    const code = await codeOf(e.address);
    if (code === "0x" || ethers.keccak256(code) !== e.codehash) fail(`contracts.${key} ${e.address}: code does not match the manifest codehash`);
  }
  const safe = await checkSafe(m);
  const deployer = await ethers.getSigner(m.deployer);
  const forbidden = [m.deployer, ...m.compromised, m.bots.keeper, m.bots.liquidator];
  const gasLog = [];
  const startBlock = await ethers.provider.getBlockNumber();
  const sent = () => gasLog.length > 0;

  // A deployment continues only from a clean checkout at the commit that started it.
  let checked = false;
  const beforeSend = () => {
    if (checked) return;
    if (git(["status", "--porcelain"]) !== "") {
      if (process.env.LUMINA_ALLOW_DIRTY === "true") console.log("WARNING: lumina-isolated checkout has uncommitted changes (LUMINA_ALLOW_DIRTY=true)");
      else fail("lumina-isolated checkout has uncommitted changes; commit first (sourceCommits must match the build)");
    }
    const head = git(["rev-parse", "HEAD"]);
    const recorded = m.sourceCommits[REPO];
    if (recorded && recorded !== head) fail(`lumina-isolated HEAD ${head} differs from the manifest sourceCommits ${recorded}: continue a partial deploy from the commit that started it`);
    checked = true;
  };
  /** Write the manifest; a run that sent a transaction records its commit (once, never replaced). */
  const save = () => {
    if (sent() && !m.sourceCommits[REPO]) m.sourceCommits[REPO] = git(["rev-parse", "HEAD"]);
    if (sent() && m.deploymentBlock === null) m.deploymentBlock = startBlock + 1;
    mf.save();
  };

  const record = (label, receipt, gasLimit) => {
    gasLog.push({ label, gasLimit, gasUsed: receipt.gasUsed, hash: receipt.hash });
    console.log(`  ${label}: tx ${receipt.hash} (gas ${receipt.gasUsed} / limit ${gasLimit})`);
  };

  /** Dry run (estimate, eth_call with the exact limit), cap check, send, receipt check. */
  const send = async (label, contract, method, args = []) => {
    beforeSend();
    if (forbidden.some((a) => eq(a, contract.target)) || m.compromised.some((a) => args.some((x) => eq(String(x), a)))) {
      fail(`${label}: refusing a transaction to or naming a forbidden address`);
    }
    const fn = contract.connect(deployer).getFunction(method);
    const gasLimit = await boundedGas(await fn.estimateGas(...args));
    await fn.staticCall(...args, { gasLimit });
    const tx = await fn.send(...args, { gasLimit });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) fail(`${label} reverted (${tx.hash})`);
    record(label, receipt, gasLimit);
    return receipt;
  };

  /** Deploy, verify on-chain (receipt, address, code, codehash), then record in the manifest. */
  const deploy = async (key, name, args) => {
    beforeSend();
    const factory = await ethers.getContractFactory(name, deployer);
    const request = await factory.getDeployTransaction(...args);
    const gasLimit = await boundedGas(await ethers.provider.estimateGas({ ...request, from: deployer.address }));
    await ethers.provider.call({ ...request, from: deployer.address, gasLimit });
    const contract = await factory.deploy(...args, { gasLimit });
    const receipt = await contract.deploymentTransaction().wait();
    if (!receipt || receipt.status !== 1) fail(`${name} deployment reverted`);
    const address = await contract.getAddress();
    if (!eq(receipt.contractAddress, address)) fail(`${name}: receipt contractAddress ${receipt.contractAddress} != ${address}`);
    const code = await codeOf(address);
    if (code === "0x") fail(`${name}: no code at ${address}`);
    record(`deploy ${name} ${address}`, receipt, gasLimit);
    m.contracts[key].address = address;
    m.contracts[key].codehash = ethers.keccak256(code);
    save();
    return address;
  };

  /** A manifest entry that is set must hold its recorded code. */
  const existing = async (key) => {
    const e = m.contracts[key];
    if (!e?.address) return null;
    const code = await codeOf(e.address);
    if (code === "0x") fail(`contracts.${key} ${e.address} has no code on this chain`);
    if (ethers.keccak256(code) !== e.codehash) fail(`contracts.${key} ${e.address}: codehash ${ethers.keccak256(code)} != manifest ${e.codehash}`);
    return e.address;
  };
  const at = (name, address) => ethers.getContractAt(name, address, deployer);
  const expectEq = (label, actual, expected) => {
    const ok = typeof expected === "bigint" ? BigInt(actual) === expected : eq(String(actual), String(expected));
    if (!ok) fail(`${label} is ${actual}, expected ${expected}`);
  };

  if (phase === "deploy") {
    // ============================================================== 1. core isolated contracts
    const timelockAddress = (await existing("isolatedTimelock")) ?? (await deploy("isolatedTimelock", "Timelock", [safe, delay]));
    const timelock = await at("Timelock", timelockAddress);
    expectEq("Timelock.admin()", await timelock.admin(), safe);
    expectEq("Timelock.delay()", await timelock.delay(), BigInt(delay));

    const whitelistAddress = (await existing("isolatedWhitelist")) ?? (await deploy("isolatedWhitelist", "LightlendWhitelist", []));
    const whitelist = await at("LightlendWhitelist", whitelistAddress);
    const registryAddress =
      (await existing("isolatedRegistry")) ?? (await deploy("isolatedRegistry", "LightlendPairRegistry", [deployer.address, []]));
    const registry = await at("LightlendPairRegistry", registryAddress);

    const pairDeployerAddress =
      (await existing("isolatedDeployer")) ??
      (await deploy("isolatedDeployer", "LightlendPairDeployer", [
        { circuitBreaker: safe, comptroller: safe, timelock: timelockAddress, lightlendWhitelist: whitelistAddress, lightlendPairRegistry: registryAddress },
      ]));
    const pd = await at("LightlendPairDeployer", pairDeployerAddress);
    expectEq("LightlendPairDeployer.circuitBreakerAddress()", await pd.circuitBreakerAddress(), safe);
    expectEq("LightlendPairDeployer.comptrollerAddress()", await pd.comptrollerAddress(), safe);
    expectEq("LightlendPairDeployer.timelockAddress()", await pd.timelockAddress(), timelockAddress);
    expectEq("LightlendPairDeployer.lightlendWhitelistAddress()", await pd.lightlendWhitelistAddress(), whitelistAddress);
    expectEq("LightlendPairDeployer.lightlendPairRegistryAddress()", await pd.lightlendPairRegistryAddress(), registryAddress);
    if ((await pd.getFunction("defaultSwappers").staticCall(0).then(() => true, () => false))) fail("LightlendPairDeployer has default swappers");

    const calcAddress =
      (await existing("isolatedRateCalculator")) ?? (await deploy("isolatedRateCalculator", "VariableInterestRate", P.rateCalculatorArgs()));
    const calc = await at("VariableInterestRate", calcAddress);
    for (const [getter, expected] of Object.entries(P.rateCalculatorImmutables())) expectEq(`VariableInterestRate.${getter}()`, await calc[getter](), expected);
    expectEq("VariableInterestRate.suffix()", await calc.suffix(), P.RATE_CALCULATOR.suffix);
    const rows = await P.simulateRates(calc);
    const show = rows.filter((r) => r.deltaTime === 1n && r.fullRateIn === P.PAIR.fullUtilizationRate);
    console.log(
      `  rate calculator ${calcAddress}: getNewRate simulated (${rows.length} calls, 0% / vertex / 100% utilization): ` +
        show.map((r) => `${Number(r.utilization) / 1000}% -> ${P.ratePerSecToAprPercent(r.ratePerSec).toFixed(2)}% APR`).join(", "),
    );

    // ============================================================== 2./3. pairs and seeds
    const pairArtifact = await hre.artifacts.readArtifact("LightlendPair");
    const pairAbi = pairArtifact.abi;
    const pairAt = (address) => new ethers.Contract(address, pairAbi, deployer);

    /** The creation code the pair deployer holds (SSTORE2: each data contract starts with 0x00). */
    const storedCreationCode = async () => {
      const a1 = await pd.contractAddress1();
      if (a1 === ZERO) return null;
      const a2 = await pd.contractAddress2();
      const part = async (a) => (a === ZERO ? "" : (await codeOf(a)).slice(4));
      return `0x${await part(a1)}${await part(a2)}`.toLowerCase();
    };

    const ensureDeployerOwner = async (what) => {
      if (!eq(await pd.owner(), deployer.address)) fail(`${what} needs the pair deployer owner, which is ${await pd.owner()} (handed over already?)`);
    };

    /** Pair configuration the deployer EOA sets while it owns the pair deployer and registry. */
    const configureForPair = async (assetAddress, seed) => {
      if ((await storedCreationCode()) !== pairArtifact.bytecode.toLowerCase()) {
        await ensureDeployerOwner("setCreationCode");
        await send("LightlendPairDeployer.setCreationCode(LightlendPair)", pd, "setCreationCode", [pairArtifact.bytecode]);
        if ((await storedCreationCode()) !== pairArtifact.bytecode.toLowerCase()) fail("the stored creation code is not the LightlendPair artifact");
      }
      if (!(await registry.deployers(pairDeployerAddress))) {
        if (!eq(await registry.owner(), deployer.address)) fail("registry.setDeployers needs the registry owner (handed over already?)");
        await send("LightlendPairRegistry.setDeployers([pair deployer], true)", registry, "setDeployers", [[pairDeployerAddress], true]);
      }
      if ((await pd.seedAmount(assetAddress)) !== seed) {
        await ensureDeployerOwner("setSeedAmount");
        await send(`LightlendPairDeployer.setSeedAmount(${assetAddress}, ${seed})`, pd, "setSeedAmount", [assetAddress, seed]);
      }
      if ((await pd.seedAmountFor(assetAddress)) !== seed) fail("seedAmountFor does not return the manifest seed");
      if (!(await whitelist.lightlendDeployerWhitelist(deployer.address))) {
        if (!eq(await whitelist.owner(), deployer.address)) fail("whitelisting the deployer needs the whitelist owner (handed over already?)");
        await send("LightlendWhitelist.setLightlendDeployerWhitelist([deployer], true)", whitelist, "setLightlendDeployerWhitelist", [[deployer.address], true]);
      }
      // Fund the pair deployer contract with the seed (the old script never did, so deploy() reverted).
      const token = new ethers.Contract(assetAddress, ERC20_ABI, deployer);
      const held = await token.balanceOf(pairDeployerAddress);
      if (held < seed) {
        const gap = seed - held;
        const own = await token.balanceOf(deployer.address);
        if (own < gap) fail(`the deployer holds ${own} of ${await token.symbol()}, the seed needs ${gap} more`);
        await send(`fund the pair deployer with the ${await token.symbol()} seed (${gap})`, token, "transfer", [pairDeployerAddress, gap]);
      }
    };

    /** A pair this pair deployer created for (asset, collateral), e.g. by an interrupted run. */
    const findDeployedPair = async (asset, collateral) => {
      for (const address of await pd.getAllPairAddresses()) {
        const p = pairAt(address);
        if (eq(await p.asset(), asset) && eq(await p.collateralContract(), collateral)) return address;
      }
      return null;
    };

    for (const spec of PAIRS) {
      const i = m.markets.isolated.findIndex((x) => x.name === spec.name);
      if (i < 0) fail(`markets.isolated has no ${spec.name}`);
      const mk = m.markets.isolated[i];
      const asset = tokenOf[spec.asset];
      const collateral = tokenOf[spec.collateral];
      if (!eq(mk.asset, asset) || !eq(mk.collateral, collateral)) fail(`markets.isolated ${spec.name}: asset/collateral differ from the assets`);
      if (mk.seedAmount === null) fail(`markets.isolated ${spec.name}.seedAmount must be set (the pair seed)`);
      const seed = BigInt(mk.seedAmount);
      const launch = {
        maxLTV: P.bpsTo1e5(mk.maxLtvBps),
        cleanLiquidationFee: P.bpsTo1e5(mk.cleanLiquidationFeeBps),
        protocolLiquidationFee: P.bpsTo1e5(mk.protocolLiquidationFeeShareBps),
      };

      // Wiring invariant (plan.md): the dual oracle of this pair has the same asset/collateral order.
      const duals = m.oracle.dualOracles.filter((d) => eq(d.asset, asset) && eq(d.collateral, collateral));
      if (duals.length !== 1) fail(`oracle.dualOracles needs exactly one ${spec.name} dual oracle`);
      const dualAddress = duals[0].address;
      if (!eq(dualAddress, m.contracts[spec.dualKey].address)) fail(`oracle.dualOracles ${spec.name} is not contracts.${spec.dualKey}`);
      const dual = new ethers.Contract(dualAddress, DUAL_ORACLE_ABI, ethers.provider);
      expectEq(`${spec.name} dual oracle ASSET()`, await dual.ASSET(), asset);
      expectEq(`${spec.name} dual oracle COLLATERAL()`, await dual.COLLATERAL(), collateral);
      expectEq(`${spec.name} dual oracle GUARD()`, await dual.GUARD(), m.contracts.priceGuard.address);
      const sourceOf = (token) =>
        [...m.oracle.coreSources, ...m.oracle.fixedSources].find((s) => eq(s.asset, token))?.address;
      expectEq(`${spec.name} dual oracle ASSET_PRICE_SOURCE()`, await dual.ASSET_PRICE_SOURCE(), sourceOf(asset));
      expectEq(`${spec.name} dual oracle COLLATERAL_PRICE_SOURCE()`, await dual.COLLATERAL_PRICE_SOURCE(), sourceOf(collateral));

      let pairAddress = await existing(spec.key);
      if (pairAddress && !eq(mk.pair, pairAddress)) fail(`markets.isolated ${spec.name}.pair ${mk.pair} != contracts.${spec.key} ${pairAddress}`);
      let created = false;
      if (!pairAddress) {
        pairAddress = await findDeployedPair(asset, collateral);
        if (pairAddress) console.log(`  ${spec.name}: adopting pair ${pairAddress} (created by an earlier run)`);
      }
      if (!pairAddress) {
        await configureForPair(asset, seed);
        const configData = P.encodePairConfig(ethers.AbiCoder.defaultAbiCoder(), {
          asset,
          collateral,
          oracle: dualAddress,
          maxOracleDeviation: P.PAIR.maxOracleDeviation,
          rateContract: calcAddress,
          fullUtilizationRate: P.PAIR.fullUtilizationRate,
          ...launch,
        });
        const receipt = await send(`LightlendPairDeployer.deploy(${spec.name})`, pd, "deploy", [configData]);
        const logs = receipt.logs.filter((l) => eq(l.address, pairDeployerAddress)).map((l) => pd.interface.parseLog(l));
        const ev = logs.find((e) => e?.name === "LogDeploy");
        if (!ev) fail(`${spec.name}: no LogDeploy event`);
        pairAddress = ethers.getAddress(ev.args.address_);
        created = true;
      }

      // ---- verify on-chain, then record (parameters read back from the chain)
      const pair = pairAt(pairAddress);
      const code = await codeOf(pairAddress);
      if (code === "0x") fail(`${spec.name}: no code at ${pairAddress}`);
      expectEq(`${spec.name} DEPLOYER_ADDRESS()`, await pair.DEPLOYER_ADDRESS(), pairDeployerAddress);
      if (!(await pd.isDeployedPair(pairAddress))) fail(`${spec.name}: not recorded by the pair deployer`);
      const pairName = await pair.name();
      expectEq(`${spec.name} registry deployedPairsByName(${pairName})`, await registry.deployedPairsByName(pairName), pairAddress);
      expectEq(`${spec.name} asset()`, await pair.asset(), asset);
      expectEq(`${spec.name} collateralContract()`, await pair.collateralContract(), collateral);
      const rateInfo = await pair.exchangeRateInfo();
      expectEq(`${spec.name} exchangeRateInfo().oracle`, rateInfo.oracle, dualAddress);
      expectEq(`${spec.name} rateContract()`, await pair.rateContract(), calcAddress);
      expectEq(`${spec.name} owner()`, await pair.owner(), safe);
      expectEq(`${spec.name} timelockAddress()`, await pair.timelockAddress(), timelockAddress);
      expectEq(`${spec.name} circuitBreakerAddress()`, await pair.circuitBreakerAddress(), safe);
      const onChain = {
        maxLTV: await pair.maxLTV(),
        cleanLiquidationFee: await pair.cleanLiquidationFee(),
        dirtyLiquidationFee: await pair.dirtyLiquidationFee(),
        protocolLiquidationFee: await pair.protocolLiquidationFee(),
      };
      expectEq(`${spec.name} dirtyLiquidationFee() (90% of clean)`, onChain.dirtyLiquidationFee, (onChain.cleanLiquidationFee * 90_000n) / 100_000n);
      if (created) {
        // First setup: the launch values (spec 3.1) and this script's oracle bound.
        for (const k of Object.keys(launch)) expectEq(`${spec.name} ${k}() at launch`, onChain[k], launch[k]);
        expectEq(`${spec.name} maxOracleDeviation at launch`, rateInfo.maxOracleDeviation, P.PAIR.maxOracleDeviation);
      }

      // Seed: created, registered and seeded in one deploy() transaction; the seed shares sit with
      // the pair deployer contract (it has no redeem path).
      const [creation] = await pd.queryFilter(pd.filters.LogDeploy(pairAddress), m.deploymentBlock ?? 0, "latest");
      if (!creation) fail(`${spec.name}: no LogDeploy for ${pairAddress}`);
      const config = P.decodePairConfig(ethers.AbiCoder.defaultAbiCoder(), creation.args.configData);
      const deposits = await pair.queryFilter(pair.filters.Deposit(), creation.blockNumber, creation.blockNumber);
      const seedDeposit = deposits.find((d) => d.transactionHash === creation.transactionHash);
      if (!seedDeposit || !eq(seedDeposit.args.caller, pairDeployerAddress) || !eq(seedDeposit.args.owner, pairDeployerAddress)) {
        fail(`${spec.name}: no seed Deposit by the pair deployer in the creation transaction ${creation.transactionHash}`);
      }
      if (seedDeposit.args.assets !== seed) fail(`${spec.name}: seeded ${seedDeposit.args.assets}, manifest seedAmount ${seed}`);
      const seedShares = await pair.balanceOf(pairDeployerAddress);
      if (seedShares < seedDeposit.args.shares) fail(`${spec.name}: the pair deployer holds ${seedShares} seed shares, minted ${seedDeposit.args.shares}`);

      m.contracts[spec.key].address = pairAddress;
      m.contracts[spec.key].codehash = ethers.keccak256(code);
      mk.pair = pairAddress;
      mk.maxLtvBps = P.e5ToBps(onChain.maxLTV, `${spec.name} maxLTV`);
      mk.cleanLiquidationFeeBps = P.e5ToBps(onChain.cleanLiquidationFee, `${spec.name} cleanLiquidationFee`);
      mk.protocolLiquidationFeeShareBps = P.e5ToBps(onChain.protocolLiquidationFee, `${spec.name} protocolLiquidationFee`);
      mk.params = {
        dualOracle: ethers.getAddress(rateInfo.oracle),
        maxOracleDeviation1e5: Number(rateInfo.maxOracleDeviation),
        dirtyLiquidationFeeBps: P.e5ToBps(onChain.dirtyLiquidationFee, `${spec.name} dirtyLiquidationFee`),
        rateCalculator: ethers.getAddress(await pair.rateContract()),
        initialFullUtilizationRatePerSec: config.fullUtilizationRate.toString(),
        seedHolder: pairDeployerAddress,
        seedShares: seedDeposit.args.shares.toString(),
        creationTx: creation.transactionHash,
        rateCalculatorParams: {
          suffix: await calc.suffix(),
          vertexUtilization1e5: Number(await calc.VERTEX_UTILIZATION()),
          vertexRatePercentOfDelta1e18: (await calc.VERTEX_RATE_PERCENT()).toString(),
          minTargetUtil1e5: Number(await calc.MIN_TARGET_UTIL()),
          maxTargetUtil1e5: Number(await calc.MAX_TARGET_UTIL()),
          zeroUtilRatePerSec: (await calc.ZERO_UTIL_RATE()).toString(),
          minFullUtilRatePerSec: (await calc.MIN_FULL_UTIL_RATE()).toString(),
          maxFullUtilRatePerSec: (await calc.MAX_FULL_UTIL_RATE()).toString(),
          rateHalfLifeSec: Number(await calc.RATE_HALF_LIFE()),
        },
      };
      save();
      console.log(`  ${spec.name}: pair ${pairAddress} (${pairName}), oracle ${dualAddress}, seed ${seed} -> ${seedDeposit.args.shares} shares held by the pair deployer`);
    }

    // ============================================================== 4. handover, deployer side
    if (await whitelist.lightlendDeployerWhitelist(deployer.address)) {
      if (!eq(await whitelist.owner(), deployer.address)) fail("the deployer is still whitelisted but no longer owns the whitelist");
      await send("LightlendWhitelist.setLightlendDeployerWhitelist([deployer], false)", whitelist, "setLightlendDeployerWhitelist", [[deployer.address], false]);
    }
    if (await registry.deployers(deployer.address)) {
      if (!eq(await registry.owner(), deployer.address)) fail("the deployer is a registry deployer but no longer owns the registry");
      await send("LightlendPairRegistry.setDeployers([deployer], false)", registry, "setDeployers", [[deployer.address], false]);
    }
    for (const [label, c] of [["LightlendWhitelist", whitelist], ["LightlendPairRegistry", registry]]) {
      const owner = await c.owner();
      if (eq(owner, deployer.address)) {
        if (!eq(await c.pendingOwner(), safe)) await send(`${label}.transferOwnership(Safe) (pending until the Safe accepts)`, c, "transferOwnership", [safe]);
      } else if (!eq(owner, safe)) {
        fail(`${label} owner is ${owner}, neither the deployer nor the Safe`);
      }
    }
    const pdOwner = await pd.owner();
    if (eq(pdOwner, deployer.address)) await send("LightlendPairDeployer.transferOwnership(Safe)", pd, "transferOwnership", [safe]);
    else if (!eq(pdOwner, safe)) fail(`LightlendPairDeployer owner is ${pdOwner}, neither the deployer nor the Safe`);
    expectEq("LightlendPairDeployer.owner() after the handover", await pd.owner(), safe);

    const next = [];
    for (const [label, c] of [["LightlendWhitelist", whitelist], ["LightlendPairRegistry", registry]]) {
      if (eq(await c.pendingOwner(), safe)) next.push(`${label}(${c.target}).acceptOwnership()`);
    }
    for (const spec of PAIRS) {
      const pair = pairAt(m.contracts[spec.key].address);
      if (!(await pair.deployerSwapperRevoked())) next.push(`${spec.name} pair(${pair.target}).revokeDeployerSwapperAccess()`);
    }
    save();
    if (next.length) console.log(`NEXT (Safe ${safe}, then LUMINA_ISOLATED_PHASE=finalize):\n  ${next.join("\n  ")}`);
  }

  if (phase === "finalize") {
    // ============================================================== 5. roles, read from the chain
    for (const key of ["isolatedTimelock", "isolatedWhitelist", "isolatedRegistry", "isolatedDeployer", "isolatedRateCalculator", ...PAIRS.map((p) => p.key)]) {
      if (!(await existing(key))) fail(`contracts.${key} is not deployed (run LUMINA_ISOLATED_PHASE=deploy first)`);
    }
    const c = m.contracts;
    const timelock = await at("Timelock", c.isolatedTimelock.address);
    const whitelist = await at("LightlendWhitelist", c.isolatedWhitelist.address);
    const registry = await at("LightlendPairRegistry", c.isolatedRegistry.address);
    const pd = await at("LightlendPairDeployer", c.isolatedDeployer.address);
    const pairAbi = (await hre.artifacts.readArtifact("LightlendPair")).abi;
    const observed = {
      timelockAdmin: await timelock.admin(),
      deployerOwner: await pd.owner(),
      deployerCircuitBreaker: await pd.circuitBreakerAddress(),
      deployerComptroller: await pd.comptrollerAddress(),
      deployerTimelock: await pd.timelockAddress(),
      registryOwner: await registry.owner(),
      whitelistOwner: await whitelist.owner(),
    };
    const expected = {
      timelockAdmin: safe,
      deployerOwner: safe,
      deployerCircuitBreaker: safe,
      deployerComptroller: safe,
      deployerTimelock: c.isolatedTimelock.address,
      registryOwner: safe,
      whitelistOwner: safe,
      pairOwner: safe,
      pairTimelock: c.isolatedTimelock.address,
      pairCircuitBreaker: safe,
    };
    const problems = [];
    const check = (label, actual, want) => {
      if (!eq(String(actual), String(want))) problems.push(`${label} is ${actual}, expected ${want}`);
    };
    for (const [k, v] of Object.entries(observed)) check(k, v, expected[k]);
    check("Timelock.pendingAdmin()", await timelock.pendingAdmin(), ZERO);
    check("Timelock.delay()", await timelock.delay(), delay);
    check("LightlendWhitelist.pendingOwner()", await whitelist.pendingOwner(), ZERO);
    check("LightlendPairRegistry.pendingOwner()", await registry.pendingOwner(), ZERO);
    check("LightlendPairDeployer.lightlendWhitelistAddress()", await pd.lightlendWhitelistAddress(), c.isolatedWhitelist.address);
    check("LightlendPairDeployer.lightlendPairRegistryAddress()", await pd.lightlendPairRegistryAddress(), c.isolatedRegistry.address);
    for (const a of forbidden) {
      if (await whitelist.lightlendDeployerWhitelist(a)) problems.push(`${a} is whitelisted in LightlendWhitelist`);
      if (await registry.deployers(a)) problems.push(`${a} is a LightlendPairRegistry deployer`);
    }
    for (const spec of PAIRS) {
      const pair = new ethers.Contract(c[spec.key].address, pairAbi, ethers.provider);
      check(`${spec.name} owner()`, await pair.owner(), expected.pairOwner);
      check(`${spec.name} pendingOwner()`, await pair.pendingOwner(), ZERO);
      check(`${spec.name} timelockAddress()`, await pair.timelockAddress(), expected.pairTimelock);
      check(`${spec.name} pendingTimelockAddress()`, await pair.pendingTimelockAddress(), ZERO);
      check(`${spec.name} circuitBreakerAddress()`, await pair.circuitBreakerAddress(), expected.pairCircuitBreaker);
      if (!(await pair.deployerSwapperRevoked())) problems.push(`${spec.name} deployerSwapperRevoked() is false (the Safe must call revokeDeployerSwapperAccess)`);
    }
    if (problems.length) fail(`the isolated handover is not complete:\n  - ${problems.join("\n  - ")}`);
    for (const [k, v] of Object.entries(expected)) m.roles.isolated[k] = ethers.getAddress(v);
    m.roles.isolated.timelockDelaySec = Number(await timelock.delay());
    save();
    console.log("  roles.isolated: Timelock admin, pair deployer owner / circuit breaker / comptroller, registry and whitelist owner, pair owner and circuit breaker = Safe; pair and deployer timelock = Timelock; nothing pending; swapper access revoked");
  }

  const total = gasLog.reduce((s, x) => s + x.gasUsed, 0n);
  const largest = gasLog.reduce((a, x) => (!a || x.gasUsed > a.gasUsed ? x : a), null);
  console.log(
    `deploy-lighter-isolated (${phase}): OK (${gasLog.length} transaction(s), gas used ${total}` +
      (largest ? `; largest ${largest.gasUsed} / limit ${largest.gasLimit}: ${largest.label}` : "") +
      ")",
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
