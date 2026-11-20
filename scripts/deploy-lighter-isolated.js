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
//        same asset/collateral order.
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
//        Timelock, nothing pending, deployer and bots without deploy rights, swapper access revoked,
//        no default swapper, no approved swapper); only then are the observed holders written to
//        `roles.isolated`.
//
// Usage (the chain comes from the manifest; the RPC URL from the env var the manifest names):
//   LUMINA_ISOLATED_PHASE=deploy LUMINA_MANIFEST=/path/manifest.json \
//   LUMINA_DEPLOY_CHECKPOINT=/path/deploy-checkpoint.json LIGHTER_DEVNET_RPC_URL=... \
//     npx hardhat run scripts/deploy-lighter-isolated.js --network lighterDevnet
// Optional:
//   LUMINA_MANIFEST_LOADER  path to deployments/index.mjs (default: the monorepo submodule layout);
//                           the Safe constants are read from <monorepo>/scripts/lib/checks.mjs next to it
//   LUMINA_ALLOW_DIRTY=true deploy from a checkout with uncommitted changes (local iteration only)
//   LUMINA_EXPECT_NOOP=1    refuse every broadcast and every manifest or checkpoint change (no-op check)
//   LUMINA_ISOLATED_RECOVER_ONLY=1  phase "deploy" only reconciles a pending record (adopting and
//                           publishing a mined result) and stops before its first new transaction
//                           (the harness runs it before any seed funding, as S4c's run.mjs does)
//   LUMINA_ISOLATED_TEST_CRASH=<before-send|after-mined|after-done>:<step>  exit with 97 at that
//                           point (crash-recovery tests; accepted only on an anvil node)
//
// Before the first transaction (the Timelock, the pair deployer and the pairs name the Safe and the
// oracles from construction):
//   - Safe: the GnosisSafeProxy v1.3.0 runtime, the singleton and fallback handler codehashes pinned
//     in lumina-monorepo scripts/lib/checks.mjs, owners, threshold, slot 0, handler slot, VERSION,
//     no module, no guard; the S4c Safe probe in the deploy checkpoint (`safeProbe`) verifies
//     on-chain (queue then cancel, both from the Safe with ExecutionSuccess, the action no longer
//     queued) and the Safe emitted no AddedOwner / RemovedOwner / ChangedThreshold since the probe;
//   - wiring (plan.md invariant): the codehashes of the oracle and core contracts it reads, the
//     guard's market 0 = the WETH LighterCorePriceSource = the AaveOracle WETH source = the WETH side
//     of both dual oracles, USDC priced by the fixed source, each dual oracle in its pair's
//     asset/collateral order with the manifest guard.
//
// Crash recovery (write-ahead, scripts/lighter/recovery.js; the same mechanism as S4c): before every
// CREATE or state-changing transaction a pending record (step, source commit, deployer nonce,
// expected address, target and calldata hash) goes into the deploy checkpoint (`isolatedPending`).
// A CREATE's manifest entry is written only after that contract's own checks pass, then the record
// is cleared. A rerun that finds a record reconciles it first: the deployer's nonce must be the
// recorded one (never mined: the record is dropped) or one more, and the transaction at that nonce
// must be the planned one, successful, from the same commit; then the result is adopted and checked
// like a fresh one. Anything else (another commit, an unexpected or reverted transaction at that
// nonce, more transactions after it, a transaction still in the mempool) stops with a recovery
// report; nothing is deployed twice. A pair created by a run that lost its record is found through
// the pair deployer and adopted under the same launch checks as a new pair.
//
// Signing: every transaction is sent from `manifest.deployer` through the network's accounts (an
// unlocked anvil account on the local harness; S12 needs a signer for the deployer key).
//
// Idempotent per manifest entry: a contract with a manifest entry is checked (code, codehash) and
// reused; every configuration and handover call is sent only when the chain still needs it. A run
// that sends nothing leaves the manifest and the checkpoint byte-identical. A run that sends or
// adopts continues only from the lumina-isolated commit the manifest records (or records HEAD when
// none is), from a clean checkout. Pair parameters are written from on-chain reads: a pair new to
// the manifest (created or adopted) must have the launch values (spec 3.1 and isolated-params.js,
// starting full-utilization rate included); a recorded pair must match the manifest.
// Gas: every transaction is dry-run first (estimate, then eth_call with the exact limit); its
// explicit limit is the estimate + 25%, refused above the EIP-7825 per-tx cap (and the block limit).

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const P = require("./lighter/isolated-params");
const R = require("./lighter/recovery");

const { ethers } = hre;

const TX_GAS_CAP = 16_777_216n; // EIP-7825 (Fusaka) per-transaction gas cap, 2^24
const GAS_BUFFER_PERCENT = 25n;
const REPO = "lumina-isolated";
const PHASES = ["deploy", "finalize"];
const ZERO = ethers.ZeroAddress;
const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const SAFE_FALLBACK_HANDLER_SLOT = ethers.id("fallback_manager.handler.address");
const SAFE_GUARD_SLOT = ethers.id("guard_manager.guard.address");
const EXPECT_NOOP = process.env.LUMINA_EXPECT_NOOP === "1";
const RECOVER_ONLY = process.env.LUMINA_ISOLATED_RECOVER_ONLY === "1";
const TEST_CRASH = process.env.LUMINA_ISOLATED_TEST_CRASH || null;
const LOG_RANGE = 5_000;

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
const SAFE_OWNER_EVENTS = ["AddedOwner(address)", "RemovedOwner(address)", "ChangedThreshold(uint256)"].map((s) => ethers.id(s));
const DUAL_ORACLE_ABI = [
  "function ASSET() view returns (address)",
  "function COLLATERAL() view returns (address)",
  "function ASSET_PRICE_SOURCE() view returns (address)",
  "function COLLATERAL_PRICE_SOURCE() view returns (address)",
  "function GUARD() view returns (address)",
];
const EXECUTOR_ABI = [
  "event QueueTransaction(bytes32 indexed txHash, address indexed target, bytes32 codehash, bytes data, uint256 eta)",
  "event CancelTransaction(bytes32 indexed txHash, address indexed target, bytes data, uint256 eta)",
  "function isQueued(bytes32 txHash) view returns (bool)",
];
const GUARD_ABI = [
  "function getMarket(uint16 marketId) view returns (bool guarded, address source, uint256 refPrice, uint64 refObservedAt, uint256 corePrice, uint64 lastCoreChangeAt, uint64 lastObservedAt)",
];
const AAVE_ORACLE_ABI = ["function getSourceOfAsset(address asset) view returns (address)"];
const PROVIDER_ABI = ["function getPriceOracle() view returns (address)"];
const SAFE_EXECUTION_SUCCESS = ethers.id("ExecutionSuccess(bytes32,uint256)");

function fail(message) {
  throw new Error(`deploy-lighter-isolated: ${message}`);
}

function eq(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function loaderPath() {
  return process.env.LUMINA_MANIFEST_LOADER || path.resolve(__dirname, "../../../deployments/index.mjs");
}

async function loadMonorepoModules() {
  const loader = loaderPath();
  if (!fs.existsSync(loader)) fail(`manifest loader not found at ${loader} (set LUMINA_MANIFEST_LOADER)`);
  const checks = path.resolve(path.dirname(loader), "..", "scripts", "lib", "checks.mjs");
  if (!fs.existsSync(checks)) fail(`lumina-monorepo scripts/lib/checks.mjs not found at ${checks} (the pinned Safe constants)`);
  return { loader: await import(pathToFileURL(loader).href), checks: await import(pathToFileURL(checks).href) };
}

function git(args) {
  return execFileSync("git", args, { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim();
}

function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Exit with 97 at a named point (crash-recovery tests only; checked to run on anvil). */
function crashPoint(when, step) {
  if (TEST_CRASH === `${when}:${step}`) {
    console.log(`TEST CRASH: ${when} ${step}`);
    process.exit(97);
  }
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
    if (EXPECT_NOOP) fail(`no-op mode: the manifest ${this.file} would change`);
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

/** A receipt's position, for ordering (block, then index). */
function position(r) {
  return [BigInt(r.blockNumber), BigInt(r.index ?? r.transactionIndex ?? 0)];
}

function before(a, b) {
  const [ab, ai] = position(a);
  const [bb, bi] = position(b);
  return ab < bb || (ab === bb && ai < bi);
}

/**
 * The Safe must be the v1.3.0 Safe the manifest describes, and must have proven a real 2-of-3
 * transaction (the S4c probe in the deploy checkpoint) with no owner or threshold change since,
 * before anything names it as owner or admin.
 */
async function checkSafe(m, checks, checkpoint) {
  const safe = m.safe.address;
  const code = await codeOf(safe);
  if (!safe || code === "0x") fail("safe.address must be set and hold code (the core deploy creates the Safe)");
  if (code.toLowerCase() !== checks.SAFE_PROXY_RUNTIME_V130.toLowerCase()) fail(`Safe ${safe}: runtime is not the GnosisSafeProxy v1.3.0 proxy (codehash ${ethers.keccak256(code)})`);
  const art = checks.harnessSafeArtifacts();
  const singletonSpec = art.singletons.find((s) => eq(s.address, m.safe.singleton));
  if (!singletonSpec) fail(`safe.singleton ${m.safe.singleton} is not a pinned v1.3.0 singleton`);
  const singletonHash = ethers.keccak256(await codeOf(m.safe.singleton));
  if (singletonHash !== singletonSpec.codehash.toLowerCase()) fail(`Safe singleton ${m.safe.singleton}: codehash ${singletonHash}, pinned ${singletonSpec.name} ${singletonSpec.codehash}`);
  if (!eq(m.safe.fallbackHandler, art.handler.address)) fail(`safe.fallbackHandler ${m.safe.fallbackHandler} is not the pinned CompatibilityFallbackHandler ${art.handler.address}`);
  const handlerHash = ethers.keccak256(await codeOf(m.safe.fallbackHandler));
  if (handlerHash !== art.handler.codehash.toLowerCase()) fail(`Safe fallback handler ${m.safe.fallbackHandler}: codehash ${handlerHash}, pinned ${art.handler.codehash}`);

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

  // The S4c probe: queue, then cancel, both real Safe transactions on this chain.
  const probe = checkpoint.read().safeProbe;
  const executor = m.contracts.executor?.address;
  if (!probe || !eq(probe.safe, safe) || !eq(probe.executor, executor)) fail("no Safe probe for this Safe and Executor in the deploy checkpoint (run the core deploy first)");
  const queue = await ethers.provider.getTransactionReceipt(probe.queueTx);
  const cancel = await ethers.provider.getTransactionReceipt(probe.cancelTx);
  if (!queue || !cancel) fail("Safe probe: queue or cancel transaction not mined on this chain");
  if (!before(queue, cancel)) fail(`Safe probe: the cancel (${probe.cancelTx}) is not after the queue (${probe.queueTx})`);
  const ex = new ethers.Contract(executor, EXECUTOR_ABI, ethers.provider);
  if (await ex.isQueued(probe.action)) fail(`Safe probe: the probe action ${probe.action} is queued on the Executor again`);
  for (const [r, eventName] of [[queue, "QueueTransaction"], [cancel, "CancelTransaction"]]) {
    if (r.status !== 1 || !eq(r.to, safe)) fail(`Safe probe ${eventName} tx ${r.hash}: failed, or not sent to the Safe`);
    if (!r.logs.some((l) => eq(l.address, safe) && l.topics[0] === SAFE_EXECUTION_SUCCESS)) fail(`Safe probe ${eventName} tx ${r.hash}: no ExecutionSuccess`);
    const ev = r.logs.filter((l) => eq(l.address, executor)).map((l) => ex.interface.parseLog(l)).find((e) => e?.name === eventName);
    if (!ev || ev.args.txHash !== probe.action) fail(`Safe probe ${eventName} tx ${r.hash}: no Executor ${eventName} for the probe action`);
  }
  // No owner or threshold change since the probe proved the signer set.
  const latest = await ethers.provider.getBlockNumber();
  const changes = await R.getLogsChunked(ethers.provider, { address: safe, topics: [SAFE_OWNER_EVENTS] }, queue.blockNumber, latest, LOG_RANGE);
  if (changes.length) fail(`Safe ${safe}: ${changes.length} owner/threshold change event(s) since the probe (first in tx ${changes[0].transactionHash}); run a new probe`);
  return safe;
}

/** Refusal reason if the pair deployer has a default swapper (only a contract revert on index 0 means none). */
async function defaultSwapperProblem(pd) {
  try {
    const first = await pd.defaultSwappers(0);
    return `LightlendPairDeployer has a default swapper (${first})`;
  } catch (err) {
    if (!R.isContractRevert(err)) throw err;
    return null;
  }
}

/** Every swapper a SetSwapper log since the pair's creation block named must be off (leverage paths stay closed). */
async function approvedSwappers(pair, fromBlock) {
  const topic = pair.interface.getEvent("SetSwapper").topicHash;
  const logs = await R.getLogsChunked(ethers.provider, { address: await pair.getAddress(), topics: [topic] }, fromBlock, await ethers.provider.getBlockNumber(), LOG_RANGE);
  const approved = [];
  for (const l of logs) {
    const who = pair.interface.parseLog(l).args.swapper;
    if (await pair.swappers(who)) approved.push(`swapper ${who} is approved (SetSwapper in ${l.transactionHash})`);
  }
  return { approved, logs: logs.length };
}

/** Thrown to stop LUMINA_ISOLATED_RECOVER_ONLY before the first new transaction. */
class RecoverOnlyStop extends Error {}

async function main() {
  const phase = process.env.LUMINA_ISOLATED_PHASE;
  if (!PHASES.includes(phase)) fail(`set LUMINA_ISOLATED_PHASE to one of ${PHASES.join(", ")}`);
  const manifestPath = process.env.LUMINA_MANIFEST;
  if (!manifestPath) fail("set LUMINA_MANIFEST to the manifest path");
  const checkpointPath = process.env.LUMINA_DEPLOY_CHECKPOINT;
  if (!checkpointPath || !fs.existsSync(checkpointPath)) fail("set LUMINA_DEPLOY_CHECKPOINT to the deploy checkpoint (with the S4c Safe probe)");
  const { loader, checks } = await loadMonorepoModules();
  const mf = new ManifestFile(loader, path.resolve(manifestPath));
  const m = mf.data;
  const checkpoint = new R.Checkpoint(path.resolve(checkpointPath), { noop: EXPECT_NOOP });

  // ---- chain: from the manifest, refused on mismatch
  const network = await ethers.provider.getNetwork();
  if (BigInt(m.chainId) !== network.chainId) fail(`manifest chainId ${m.chainId} != RPC chain ${network.chainId} (network ${hre.network.name})`);
  if (TEST_CRASH && !/^anvil\//i.test(await ethers.provider.send("web3_clientVersion", []))) fail("LUMINA_ISOLATED_TEST_CRASH is only accepted on an anvil node");
  console.log(`deploy-lighter-isolated (${phase}${EXPECT_NOOP ? ", no-op mode" : ""}): ${m.environment} (chain ${m.chainId}), manifest ${mf.file}`);

  // ---- inputs from the core and oracle deploys, checked on-chain before any transaction
  const WETH = m.assets.WETH.address;
  const USDC = m.assets.USDC.address;
  const tokenOf = { WETH, USDC };
  const delay = m.roles.isolated.timelockDelaySec;
  if (delay !== 2 * 24 * 3600) fail(`roles.isolated.timelockDelaySec must be 172800 (2 days), got ${delay}`);
  for (const key of ["executor", "priceGuard", "ethPriceSource", "usdcPriceSource", "aaveOracle", "poolAddressesProvider", ...PAIRS.map((p) => p.dualKey)]) {
    const e = m.contracts[key];
    if (!e?.address) fail(`contracts.${key} must be deployed first (core and oracle deploy)`);
    const code = await codeOf(e.address);
    if (code === "0x" || ethers.keccak256(code) !== e.codehash) fail(`contracts.${key} ${e.address}: code does not match the manifest codehash`);
  }
  // Wiring invariant (plan.md): one LighterCorePriceSource for WETH wherever it is read.
  const ethSource = m.contracts.ethPriceSource.address;
  const usdSource = m.contracts.usdcPriceSource.address;
  const core0 = m.oracle.coreSources.find((s) => s.marketId === 0);
  if (!core0 || !eq(core0.asset, WETH) || !eq(core0.address, ethSource)) fail("oracle.coreSources market 0 is not the WETH contracts.ethPriceSource");
  const fixedUsd = m.oracle.fixedSources.find((s) => eq(s.asset, USDC));
  if (!fixedUsd || !eq(fixedUsd.address, usdSource)) fail("oracle.fixedSources USDC is not contracts.usdcPriceSource");
  const sourceOf = (token) => (eq(token, WETH) ? ethSource : eq(token, USDC) ? usdSource : null);
  const [guarded, guardSource] = await new ethers.Contract(m.contracts.priceGuard.address, GUARD_ABI, ethers.provider).getMarket(0);
  if (!guarded || !eq(guardSource, ethSource)) fail(`guard market 0 is ${guarded ? `sourced from ${guardSource}` : "not guarded"}, expected the WETH source ${ethSource}`);
  const aaveOracle = new ethers.Contract(m.contracts.aaveOracle.address, AAVE_ORACLE_ABI, ethers.provider);
  for (const [symbol, token] of Object.entries(tokenOf)) {
    const s = await aaveOracle.getSourceOfAsset(token);
    if (!eq(s, sourceOf(token))) fail(`AaveOracle.getSourceOfAsset(${symbol}) is ${s}, expected ${sourceOf(token)}`);
  }
  const providerOracle = await new ethers.Contract(m.contracts.poolAddressesProvider.address, PROVIDER_ABI, ethers.provider).getPriceOracle();
  if (!eq(providerOracle, m.contracts.aaveOracle.address)) fail(`PoolAddressesProvider.getPriceOracle() is ${providerOracle}, not contracts.aaveOracle`);
  const dualFor = {};
  for (const spec of PAIRS) {
    const asset = tokenOf[spec.asset];
    const collateral = tokenOf[spec.collateral];
    const duals = m.oracle.dualOracles.filter((d) => eq(d.asset, asset) && eq(d.collateral, collateral));
    if (duals.length !== 1 || !duals[0].address) fail(`oracle.dualOracles needs exactly one deployed ${spec.name} dual oracle`);
    const address = duals[0].address;
    if (!eq(address, m.contracts[spec.dualKey].address)) fail(`oracle.dualOracles ${spec.name} is not contracts.${spec.dualKey}`);
    const dual = new ethers.Contract(address, DUAL_ORACLE_ABI, ethers.provider);
    const wiring = [
      ["ASSET()", await dual.ASSET(), asset],
      ["COLLATERAL()", await dual.COLLATERAL(), collateral],
      ["GUARD()", await dual.GUARD(), m.contracts.priceGuard.address],
      ["ASSET_PRICE_SOURCE()", await dual.ASSET_PRICE_SOURCE(), sourceOf(asset)],
      ["COLLATERAL_PRICE_SOURCE()", await dual.COLLATERAL_PRICE_SOURCE(), sourceOf(collateral)],
    ];
    for (const [getter, actual, expected] of wiring) {
      if (!eq(actual, expected)) fail(`${spec.name} dual oracle ${address} ${getter} is ${actual}, expected ${expected} (asset/collateral order, single source)`);
    }
    dualFor[spec.key] = address;
  }
  const safe = await checkSafe(m, checks, checkpoint);

  const deployer = await ethers.getSigner(m.deployer);
  const forbidden = [m.deployer, ...m.compromised, m.bots.keeper, m.bots.liquidator];
  const head = git(["rev-parse", "HEAD"]);
  const gasLog = [];
  const startBlock = await ethers.provider.getBlockNumber();
  let touched = false; // this run sent or adopted something: it records the commit

  // A deployment continues only from a clean checkout at the commit that started it.
  let checked = false;
  const beforeSend = () => {
    if (checked) return;
    if (git(["status", "--porcelain"]) !== "") {
      if (process.env.LUMINA_ALLOW_DIRTY === "true") console.log("WARNING: lumina-isolated checkout has uncommitted changes (LUMINA_ALLOW_DIRTY=true)");
      else fail("lumina-isolated checkout has uncommitted changes; commit first (sourceCommits must match the build)");
    }
    const recorded = m.sourceCommits[REPO];
    if (recorded && recorded !== head) fail(`lumina-isolated HEAD ${head} differs from the manifest sourceCommits ${recorded}: continue a partial deploy from the commit that started it`);
    checked = true;
    touched = true;
  };
  /** Write the manifest; a run that sent or adopted something records its commit (once, never replaced). */
  const save = () => {
    if (touched && !m.sourceCommits[REPO]) m.sourceCommits[REPO] = head;
    if (touched && m.deploymentBlock === null) m.deploymentBlock = startBlock + 1;
    mf.save();
  };
  const record = (label, receipt, gasLimit) => {
    gasLog.push({ label, gasLimit, gasUsed: receipt.gasUsed, hash: receipt.hash });
    console.log(`  ${label}: tx ${receipt.hash} (gas ${receipt.gasUsed} / limit ${gasLimit})`);
  };
  /** The deployer's next nonce; refuses while a transaction of it waits in the mempool. */
  const nextNonce = async () => {
    const latest = await ethers.provider.getTransactionCount(deployer.address, "latest");
    const pending = await ethers.provider.getTransactionCount(deployer.address, "pending");
    if (pending !== latest) fail(`the deployer has ${pending - latest} transaction(s) in the mempool (nonce ${latest}); wait for them or replace them first`);
    return latest;
  };
  const baseRecord = async (step, label) => ({
    step,
    label,
    sourceCommit: head,
    chainId: Number(m.chainId),
    deployer: deployer.address,
    nonce: await nextNonce(),
    fromBlock: await ethers.provider.getBlockNumber(),
  });

  /**
   * Dry run (estimate, eth_call with the exact limit), cap check, write-ahead record, send with that
   * nonce, receipt check. `keep`: the record stays until the caller publishes the result.
   */
  const send = async (step, label, contract, method, args = [], { keep = false, expectAddress = false } = {}) => {
    if (EXPECT_NOOP) fail(`no-op mode: refusing to send ${label}`);
    if (RECOVER_ONLY) throw new RecoverOnlyStop(label);
    beforeSend();
    const target = await contract.getAddress();
    if (forbidden.some((a) => eq(a, target)) || m.compromised.some((a) => args.some((x) => eq(String(x), a)))) {
      fail(`${label}: refusing a transaction to or naming a forbidden address`);
    }
    const c = contract.connect(deployer);
    const fn = c.getFunction(method);
    const data = c.interface.encodeFunctionData(method, args);
    const gasLimit = await boundedGas(await fn.estimateGas(...args));
    const simulated = await fn.staticCall(...args, { gasLimit });
    const rec = { ...(await baseRecord(step, label)), kind: "call", to: target, dataHash: ethers.keccak256(data) };
    if (expectAddress) rec.expectedAddress = ethers.getAddress(simulated);
    checkpoint.setPending(rec);
    crashPoint("before-send", step);
    const tx = await fn.send(...args, { gasLimit, nonce: rec.nonce });
    checkpoint.updatePending({ hash: tx.hash });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) fail(`${label} reverted (${tx.hash}); the pending record stays for the recovery report`);
    record(label, receipt, gasLimit);
    crashPoint("after-mined", step);
    if (!keep) {
      checkpoint.clearPending();
      crashPoint("after-done", step);
    }
    return receipt;
  };

  /** CREATE with a write-ahead record; returns the address. The manifest is written by publish(). */
  const deploy = async (key, name, args) => {
    if (EXPECT_NOOP) fail(`no-op mode: refusing to deploy ${name}`);
    if (RECOVER_ONLY) throw new RecoverOnlyStop(`deploy ${name}`);
    beforeSend();
    const factory = await ethers.getContractFactory(name, deployer);
    const request = await factory.getDeployTransaction(...args);
    const gasLimit = await boundedGas(await ethers.provider.estimateGas({ ...request, from: deployer.address }));
    await ethers.provider.call({ ...request, from: deployer.address, gasLimit });
    const step = `create:${key}`;
    const rec = { ...(await baseRecord(step, `deploy ${name}`)), kind: "create", key, contractName: name, dataHash: ethers.keccak256(request.data) };
    rec.expectedAddress = ethers.getCreateAddress({ from: deployer.address, nonce: rec.nonce });
    checkpoint.setPending(rec);
    crashPoint("before-send", step);
    const tx = await deployer.sendTransaction({ ...request, gasLimit, nonce: rec.nonce });
    checkpoint.updatePending({ hash: tx.hash });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) fail(`${name} deployment reverted (${tx.hash}); the pending record stays for the recovery report`);
    if (!eq(receipt.contractAddress, rec.expectedAddress)) fail(`${name}: receipt contractAddress ${receipt.contractAddress} != expected ${rec.expectedAddress}`);
    if ((await codeOf(rec.expectedAddress)) === "0x") fail(`${name}: no code at ${rec.expectedAddress}`);
    record(`deploy ${name} ${rec.expectedAddress}`, receipt, gasLimit);
    crashPoint("after-mined", step);
    return rec.expectedAddress;
  };

  /** After a CREATE passed its own checks: manifest entry, then the record is cleared. */
  const publish = async (key, address) => {
    m.contracts[key].address = address;
    m.contracts[key].codehash = ethers.keccak256(await codeOf(address));
    save();
    checkpoint.clearPending();
    crashPoint("after-done", `create:${key}`);
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
  const recoveryFail = (why, p) =>
    fail(
      `recovery: ${why}.\n  pending record (${checkpoint.file}, isolatedPending): ${JSON.stringify(p)}\n` +
        "  Nothing was sent. Resolve by hand (inspect the deployer's transactions from the record's block), then remove isolatedPending.",
    );

  /**
   * Reconciles a pending record with the chain before anything is sent. Returns the adopted record
   * (a mined CREATE or pair deploy, published later after its checks) or null.
   */
  const reconcile = async () => {
    const p = checkpoint.pending;
    if (!p) return null;
    if (EXPECT_NOOP) recoveryFail("no-op mode found a pending record", p);
    console.log(`  recovery: pending record ${p.step} (nonce ${p.nonce}, commit ${p.sourceCommit})`);
    if (p.sourceCommit !== head) recoveryFail(`it was planned from lumina-isolated ${p.sourceCommit}, HEAD is ${head} (another commit)`, p);
    if (!eq(p.deployer, deployer.address) || Number(p.chainId) !== Number(m.chainId)) recoveryFail("it belongs to another deployer or chain", p);
    const latest = await ethers.provider.getTransactionCount(deployer.address, "latest");
    const pending = await ethers.provider.getTransactionCount(deployer.address, "pending");
    if (pending !== latest) recoveryFail(`the deployer has ${pending - latest} transaction(s) in the mempool`, p);
    if (latest === p.nonce) {
      console.log("  recovery: the recorded transaction was never mined (nonce unused); record dropped");
      checkpoint.clearPending();
      return null;
    }
    if (latest !== p.nonce + 1) recoveryFail(`unexpected transaction(s): the deployer's nonce is ${latest}, the record allows ${p.nonce + 1}`, p);
    const tx = await R.findTxByNonce(ethers.provider, p);
    if (!tx) recoveryFail(`the deployer's transaction at nonce ${p.nonce} was not found from block ${p.fromBlock}`, p);
    const target = tx.to ?? null;
    const planned = p.kind === "create" ? target === null : eq(target, p.to);
    if (!planned || ethers.keccak256(tx.data) !== p.dataHash) recoveryFail(`an unexpected transaction (${tx.hash}) consumed nonce ${p.nonce}`, p);
    const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
    if (!receipt || receipt.status !== 1) recoveryFail(`a reverted transaction (${tx.hash}) consumed nonce ${p.nonce}`, p);
    if (p.kind === "create" && (!eq(receipt.contractAddress, p.expectedAddress) || (await codeOf(p.expectedAddress)) === "0x")) {
      recoveryFail(`the CREATE at nonce ${p.nonce} did not leave code at ${p.expectedAddress}`, p);
    }
    beforeSend(); // adoption publishes: clean checkout, recorded commit
    // Interrupted between the manifest write and clearing the record: already published.
    const published =
      p.kind === "create"
        ? eq(m.contracts[p.key]?.address, p.expectedAddress)
        : Boolean(p.expectedAddress) && m.markets.isolated.some((mk) => eq(mk.pair, p.expectedAddress));
    if (published) {
      console.log(`  recovery: ${p.step} (tx ${tx.hash}) is already in the manifest; record cleared`);
      checkpoint.clearPending();
      return null;
    }
    console.log(`  recovery: ${p.step} was mined in tx ${tx.hash}; adopting it`);
    if (p.kind === "call" && !p.expectedAddress) {
      checkpoint.clearPending(); // a plain call: the idempotent steps below read its effect from the chain
      return null;
    }
    return { ...p, hash: tx.hash, receipt };
  };

  if (phase === "deploy" && RECOVER_ONLY && !checkpoint.pending) {
    console.log("deploy-lighter-isolated (deploy, recover only): no pending record; nothing to do");
    return;
  }
  if (phase === "deploy") {
    try {
      await deployPhase();
    } catch (err) {
      if (!(err instanceof RecoverOnlyStop)) throw err;
      if (checkpoint.pending) fail(`recover only: the pending record ${checkpoint.pending.step} is still open before ${err.message}`);
      console.log(`deploy-lighter-isolated (deploy, recover only): pending record resolved; stopped before the next transaction (${err.message})`);
    }
  }
  async function deployPhase() {
    let recovered = await reconcile();
    const takeRecovered = (step) => {
      if (!recovered) return null;
      if (recovered.step !== step) return null;
      const r = recovered;
      recovered = null;
      return r;
    };

    /** A recorded contract is checked; otherwise the recovered or a new CREATE is checked, then published. */
    const ensureContract = async (key, name, args, verify) => {
      const recorded = await existing(key);
      if (recorded) {
        await verify(recorded);
        return recorded;
      }
      let address;
      const r = takeRecovered(`create:${key}`);
      if (r) {
        const request = await (await ethers.getContractFactory(name, deployer)).getDeployTransaction(...args);
        if (ethers.keccak256(request.data) !== r.dataHash) recoveryFail(`the mined ${name} was built from other inputs than this run plans`, r);
        address = r.expectedAddress;
      } else {
        address = await deploy(key, name, args);
      }
      await verify(address);
      await publish(key, address);
      return address;
    };

    // ============================================================== 1. core isolated contracts
    const timelockAddress = await ensureContract("isolatedTimelock", "Timelock", [safe, delay], async (a) => {
      const t = await at("Timelock", a);
      expectEq("Timelock.admin()", await t.admin(), safe);
      expectEq("Timelock.pendingAdmin()", await t.pendingAdmin(), ZERO); // before anything is wired to it
      expectEq("Timelock.delay()", await t.delay(), BigInt(delay));
    });
    const whitelistAddress = await ensureContract("isolatedWhitelist", "LightlendWhitelist", [], async () => {});
    const whitelist = await at("LightlendWhitelist", whitelistAddress);
    const registryAddress = await ensureContract("isolatedRegistry", "LightlendPairRegistry", [deployer.address, []], async () => {});
    const registry = await at("LightlendPairRegistry", registryAddress);

    const pairDeployerAddress = await ensureContract(
      "isolatedDeployer",
      "LightlendPairDeployer",
      [{ circuitBreaker: safe, comptroller: safe, timelock: timelockAddress, lightlendWhitelist: whitelistAddress, lightlendPairRegistry: registryAddress }],
      async (a) => {
        const d = await at("LightlendPairDeployer", a);
        expectEq("LightlendPairDeployer.circuitBreakerAddress()", await d.circuitBreakerAddress(), safe);
        expectEq("LightlendPairDeployer.comptrollerAddress()", await d.comptrollerAddress(), safe);
        expectEq("LightlendPairDeployer.timelockAddress()", await d.timelockAddress(), timelockAddress);
        expectEq("LightlendPairDeployer.lightlendWhitelistAddress()", await d.lightlendWhitelistAddress(), whitelistAddress);
        expectEq("LightlendPairDeployer.lightlendPairRegistryAddress()", await d.lightlendPairRegistryAddress(), registryAddress);
        const problem = await defaultSwapperProblem(d);
        if (problem) fail(problem);
      },
    );
    const pd = await at("LightlendPairDeployer", pairDeployerAddress);

    const calcAddress = await ensureContract("isolatedRateCalculator", "VariableInterestRate", P.rateCalculatorArgs(), async (a) => {
      const calc = await at("VariableInterestRate", a);
      for (const [getter, expected] of Object.entries(P.rateCalculatorImmutables())) expectEq(`VariableInterestRate.${getter}()`, await calc[getter](), expected);
      expectEq("VariableInterestRate.suffix()", await calc.suffix(), P.RATE_CALCULATOR.suffix);
      const rows = await P.simulateRates(calc);
      const show = rows.filter((r) => r.deltaTime === 1n && r.fullRateIn === P.PAIR.fullUtilizationRate);
      console.log(
        `  rate calculator ${a}: getNewRate simulated (${rows.length} calls, 0% / vertex / 100% utilization): ` +
          show.map((r) => `${Number(r.utilization) / 1000}% -> ${P.ratePerSecToAprPercent(r.ratePerSec).toFixed(2)}% APR`).join(", "),
      );
    });
    const calc = await at("VariableInterestRate", calcAddress);

    // ============================================================== 2./3. pairs and seeds
    const pairArtifact = await hre.artifacts.readArtifact("LightlendPair");
    const pairAt = (address) => new ethers.Contract(address, pairArtifact.abi, deployer);
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();

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
    const configureForPair = async (spec, assetAddress, seed) => {
      if ((await storedCreationCode()) !== pairArtifact.bytecode.toLowerCase()) {
        await ensureDeployerOwner("setCreationCode");
        await send("call:setCreationCode", "LightlendPairDeployer.setCreationCode(LightlendPair)", pd, "setCreationCode", [pairArtifact.bytecode]);
        if ((await storedCreationCode()) !== pairArtifact.bytecode.toLowerCase()) fail("the stored creation code is not the LightlendPair artifact");
      }
      if (!(await registry.deployers(pairDeployerAddress))) {
        if (!eq(await registry.owner(), deployer.address)) fail("registry.setDeployers needs the registry owner (handed over already?)");
        await send("call:registry.setDeployers", "LightlendPairRegistry.setDeployers([pair deployer], true)", registry, "setDeployers", [[pairDeployerAddress], true]);
      }
      if ((await pd.seedAmount(assetAddress)) !== seed) {
        await ensureDeployerOwner("setSeedAmount");
        await send(`call:setSeedAmount:${spec.asset}`, `LightlendPairDeployer.setSeedAmount(${spec.asset}, ${seed})`, pd, "setSeedAmount", [assetAddress, seed]);
      }
      if ((await pd.seedAmountFor(assetAddress)) !== seed) fail("seedAmountFor does not return the manifest seed");
      if (!(await whitelist.lightlendDeployerWhitelist(deployer.address))) {
        if (!eq(await whitelist.owner(), deployer.address)) fail("whitelisting the deployer needs the whitelist owner (handed over already?)");
        await send("call:whitelist.add", "LightlendWhitelist.setLightlendDeployerWhitelist([deployer], true)", whitelist, "setLightlendDeployerWhitelist", [[deployer.address], true]);
      }
      // Fund the pair deployer contract with the seed (the old script never did, so deploy() reverted).
      const token = new ethers.Contract(assetAddress, ERC20_ABI, deployer);
      const held = await token.balanceOf(pairDeployerAddress);
      if (held < seed) {
        const gap = seed - held;
        const own = await token.balanceOf(deployer.address);
        if (own < gap) fail(`the deployer holds ${own} of ${spec.asset}, the seed needs ${gap} more`);
        await send(`call:fund:${spec.asset}`, `fund the pair deployer with the ${spec.asset} seed (${gap})`, token, "transfer", [pairDeployerAddress, gap]);
      }
    };

    /** A pair this pair deployer created for (asset, collateral) that the manifest does not record. */
    const findDeployedPair = async (asset, collateral) => {
      for (const address of await pd.getAllPairAddresses()) {
        const p = pairAt(address);
        if (eq(await p.asset(), asset) && eq(await p.collateralContract(), collateral)) return address;
      }
      return null;
    };
    /** LogDeploy of `pair` in a receipt of the pair deployer, decoded. */
    const logDeployIn = (receipt, pair) =>
      receipt.logs
        .filter((l) => eq(l.address, pairDeployerAddress))
        .map((l) => pd.interface.parseLog(l))
        .find((e) => e?.name === "LogDeploy" && eq(e.args.address_, pair));

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
      const dualAddress = dualFor[spec.key]; // order checked before any transaction
      const step = `call:deploy:${spec.name}`;

      const recordedAddress = await existing(spec.key);
      const wasRecorded = Boolean(recordedAddress);
      if (wasRecorded && !eq(mk.pair, recordedAddress)) fail(`markets.isolated ${spec.name}.pair ${mk.pair} != contracts.${spec.key} ${recordedAddress}`);
      let pairAddress = recordedAddress;
      let creation = null; // the receipt of the deploy() that created the pair
      let how = "recorded";
      let pendingStep = null; // the write-ahead record to clear once the pair is published
      if (!pairAddress) {
        const r = takeRecovered(step);
        if (r) {
          pairAddress = r.expectedAddress;
          creation = r.receipt;
          how = "recovered";
          pendingStep = step;
        }
      }
      if (!pairAddress) {
        pairAddress = await findDeployedPair(asset, collateral);
        if (pairAddress) how = "adopted";
      }
      if (!pairAddress) {
        await configureForPair(spec, asset, seed);
        const configData = P.encodePairConfig(abiCoder, {
          asset,
          collateral,
          oracle: dualAddress,
          maxOracleDeviation: P.PAIR.maxOracleDeviation,
          rateContract: calcAddress,
          fullUtilizationRate: P.PAIR.fullUtilizationRate,
          ...launch,
        });
        creation = await send(step, `LightlendPairDeployer.deploy(${spec.name})`, pd, "deploy", [configData], { keep: true, expectAddress: true });
        pairAddress = checkpoint.pending.expectedAddress;
        how = "created";
        pendingStep = step;
      }
      if (!wasRecorded) beforeSend(); // a pair new to the manifest: clean checkout, recorded commit
      if (how !== "recorded") console.log(`  ${spec.name}: pair ${pairAddress} ${how}`);

      // ---- the creation transaction: from this run's receipt, the recorded one, or (adoption) the logs
      if (!creation) {
        if (wasRecorded && mk.params?.creationTx) {
          creation = await ethers.provider.getTransactionReceipt(mk.params.creationTx);
        } else {
          const topics = await pd.filters.LogDeploy(pairAddress).getTopicFilter();
          const logs = await R.getLogsChunked(ethers.provider, { address: pairDeployerAddress, topics }, m.deploymentBlock ?? 0, await ethers.provider.getBlockNumber(), LOG_RANGE);
          if (logs.length !== 1) fail(`${spec.name}: ${logs.length} LogDeploy event(s) for ${pairAddress}`);
          creation = await ethers.provider.getTransactionReceipt(logs[0].transactionHash);
        }
      }
      if (!creation || creation.status !== 1) fail(`${spec.name}: creation transaction of ${pairAddress} not found or failed`);
      const ev = logDeployIn(creation, pairAddress);
      if (!ev) fail(`${spec.name}: no LogDeploy for ${pairAddress} in ${creation.hash}`);
      const config = P.decodePairConfig(abiCoder, ev.args.configData);
      const pair = pairAt(pairAddress);
      const seedDeposit = creation.logs
        .filter((l) => eq(l.address, pairAddress))
        .map((l) => pair.interface.parseLog(l))
        .find((e) => e?.name === "Deposit");
      if (!seedDeposit || !eq(seedDeposit.args.caller, pairDeployerAddress) || !eq(seedDeposit.args.owner, pairDeployerAddress)) {
        fail(`${spec.name}: no seed Deposit by the pair deployer in the creation transaction ${creation.hash}`);
      }
      if (seedDeposit.args.assets !== seed) fail(`${spec.name}: seeded ${seedDeposit.args.assets}, manifest seedAmount ${seed}`);

      // ---- verify on-chain (parameters read back from the chain)
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
        maxOracleDeviation: BigInt(rateInfo.maxOracleDeviation),
      };
      if (!wasRecorded) {
        // New to the manifest (created now, or adopted): every launch value (spec 3.1, isolated-params.js).
        for (const k of Object.keys(launch)) expectEq(`${spec.name} ${k}() at launch`, onChain[k], launch[k]);
        expectEq(`${spec.name} dirtyLiquidationFee() at launch (90% of clean)`, onChain.dirtyLiquidationFee, (onChain.cleanLiquidationFee * 90_000n) / 100_000n);
        expectEq(`${spec.name} maxOracleDeviation at launch`, onChain.maxOracleDeviation, P.PAIR.maxOracleDeviation);
        expectEq(`${spec.name} configData fullUtilizationRate at launch`, config.fullUtilizationRate, P.PAIR.fullUtilizationRate);
        expectEq(`${spec.name} configData oracle`, config.oracle, dualAddress);
        expectEq(`${spec.name} configData rateContract`, config.rateContract, calcAddress);
        for (const k of Object.keys(launch)) expectEq(`${spec.name} configData ${k}`, config[k], launch[k]);
      } else {
        // Recorded: the chain must match the manifest (governance changes update the manifest).
        expectEq(`${spec.name} maxLTV() vs manifest`, onChain.maxLTV, P.bpsTo1e5(mk.maxLtvBps));
        expectEq(`${spec.name} cleanLiquidationFee() vs manifest`, onChain.cleanLiquidationFee, P.bpsTo1e5(mk.cleanLiquidationFeeBps));
        expectEq(`${spec.name} protocolLiquidationFee() vs manifest`, onChain.protocolLiquidationFee, P.bpsTo1e5(mk.protocolLiquidationFeeShareBps));
        expectEq(`${spec.name} dirtyLiquidationFee() vs manifest`, onChain.dirtyLiquidationFee, P.bpsTo1e5(mk.params?.dirtyLiquidationFeeBps));
        expectEq(`${spec.name} maxOracleDeviation vs manifest`, onChain.maxOracleDeviation, BigInt(mk.params?.maxOracleDeviation1e5));
        expectEq(`${spec.name} creation tx vs manifest`, creation.hash, mk.params?.creationTx);
      }
      const seedShares = await pair.balanceOf(pairDeployerAddress);
      if (seedShares < seedDeposit.args.shares) fail(`${spec.name}: the pair deployer holds ${seedShares} seed shares, minted ${seedDeposit.args.shares}`);
      // No swapper may be approved (leverage paths stay off): every SetSwapper since creation.
      const swappers = await approvedSwappers(pair, creation.blockNumber);
      if (swappers.approved.length) fail(`${spec.name}: ${swappers.approved.join("; ")}`);

      m.contracts[spec.key].address = pairAddress;
      m.contracts[spec.key].codehash = ethers.keccak256(code);
      mk.pair = pairAddress;
      mk.maxLtvBps = P.e5ToBps(onChain.maxLTV, `${spec.name} maxLTV`);
      mk.cleanLiquidationFeeBps = P.e5ToBps(onChain.cleanLiquidationFee, `${spec.name} cleanLiquidationFee`);
      mk.protocolLiquidationFeeShareBps = P.e5ToBps(onChain.protocolLiquidationFee, `${spec.name} protocolLiquidationFee`);
      mk.params = {
        dualOracle: ethers.getAddress(rateInfo.oracle),
        maxOracleDeviation1e5: Number(onChain.maxOracleDeviation),
        dirtyLiquidationFeeBps: P.e5ToBps(onChain.dirtyLiquidationFee, `${spec.name} dirtyLiquidationFee`),
        rateCalculator: ethers.getAddress(await pair.rateContract()),
        initialFullUtilizationRatePerSec: config.fullUtilizationRate.toString(),
        seedHolder: pairDeployerAddress,
        seedShares: seedDeposit.args.shares.toString(),
        creationTx: creation.hash,
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
      if (pendingStep) {
        checkpoint.clearPending();
        crashPoint("after-done", pendingStep);
      }
      console.log(`  ${spec.name}: pair ${pairAddress} (${pairName}), oracle ${dualAddress}, seed ${seed} -> ${seedDeposit.args.shares} shares held by the pair deployer`);
    }
    if (recovered) recoveryFail(`the recovered step ${recovered.step} was not reached by this run`, recovered);

    // ============================================================== 4. handover, deployer side
    if (await whitelist.lightlendDeployerWhitelist(deployer.address)) {
      if (!eq(await whitelist.owner(), deployer.address)) fail("the deployer is still whitelisted but no longer owns the whitelist");
      await send("call:whitelist.remove", "LightlendWhitelist.setLightlendDeployerWhitelist([deployer], false)", whitelist, "setLightlendDeployerWhitelist", [[deployer.address], false]);
    }
    if (await registry.deployers(deployer.address)) {
      if (!eq(await registry.owner(), deployer.address)) fail("the deployer is a registry deployer but no longer owns the registry");
      await send("call:registry.removeDeployer", "LightlendPairRegistry.setDeployers([deployer], false)", registry, "setDeployers", [[deployer.address], false]);
    }
    for (const [label, c, step] of [["LightlendWhitelist", whitelist, "call:whitelist.transferOwnership"], ["LightlendPairRegistry", registry, "call:registry.transferOwnership"]]) {
      const owner = await c.owner();
      if (eq(owner, deployer.address)) {
        if (!eq(await c.pendingOwner(), safe)) await send(step, `${label}.transferOwnership(Safe) (pending until the Safe accepts)`, c, "transferOwnership", [safe]);
      } else if (!eq(owner, safe)) {
        fail(`${label} owner is ${owner}, neither the deployer nor the Safe`);
      }
    }
    const pdOwner = await pd.owner();
    if (eq(pdOwner, deployer.address)) await send("call:deployer.transferOwnership", "LightlendPairDeployer.transferOwnership(Safe)", pd, "transferOwnership", [safe]);
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
    if (checkpoint.pending) fail(`a pending record (${checkpoint.pending.step}) exists; run LUMINA_ISOLATED_PHASE=deploy first`);
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
      // Leverage paths stay closed: no swapper approved since the pair's creation (as the deploy phase).
      const creationTx = m.markets.isolated.find((x) => x.name === spec.name)?.params?.creationTx;
      const creation = creationTx ? await ethers.provider.getTransactionReceipt(creationTx) : null;
      if (!creation || creation.status !== 1) {
        problems.push(`${spec.name}: no recorded creation transaction (markets.isolated params.creationTx)`);
      } else {
        const swappers = await approvedSwappers(pair, creation.blockNumber);
        for (const a of swappers.approved) problems.push(`${spec.name}: ${a}`);
      }
    }
    const defaultSwapper = await defaultSwapperProblem(pd);
    if (defaultSwapper) problems.push(defaultSwapper);
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
