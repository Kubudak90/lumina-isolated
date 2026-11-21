// Lumina isolated pairs on Lighter EVM devnet: the deploy parameters that are not in the deployment
// manifest (spec 3.1, 3.3; plan.md S5a/S5b notes above S5c). Shared by
// scripts/deploy-lighter-isolated.js and test/lighterIsolatedParams.js, so the tested values are
// the deployed ones.
//
// From the manifest (inputs, never from here): maxLtvBps, cleanLiquidationFeeBps,
// protocolLiquidationFeeShareBps and seedAmount of each `markets.isolated` entry, the dual oracles
// (`oracle.dualOracles`), the Safe and the 2-day delay (`roles.isolated.timelockDelaySec`).
//
// Rate calculator: one VariableInterestRate shared by both pairs (manifest
// `contracts.isolatedRateCalculator`). Conservative, bounded values, in line with the core reserves
// (LighterMarketInput: optimal usage 80%, base 0%, 3-5% at the kink):
//   - 0% APR at 0% utilization;
//   - the vertex (kink) at 80% utilization, at 10% of the full-utilization rate;
//   - full-utilization rate starts at 50% APR (pair config) and adapts only between 25% and 100% APR,
//     so the vertex rate stays between 2.5% and 10% APR (5% at the start);
//   - no adaptation while utilization is between 70% and 85%; outside that band the
//     full-utilization rate moves with a 2-day half life (the slowest FraxLend default).
// The constructor validation (ISO-04) accepts these values; getNewRate is simulated at 0%, the vertex
// and 100% utilization before any pair uses the calculator (S5a review note), see simulateRates().

/** Seconds per year used for the APR conversions (VariableInterestRate: 365.24 days). */
const SECONDS_PER_YEAR = 31_556_736n;

/** APR in basis points -> per-second rate with 18 decimals (rounded down). */
function aprBpsToRatePerSec(bps) {
  return (BigInt(bps) * 10n ** 14n) / SECONDS_PER_YEAR;
}

/** Per-second rate (18 decimals) -> APR in percent, for reports. */
function ratePerSecToAprPercent(rate) {
  return Number(BigInt(rate) * SECONDS_PER_YEAR) / 1e16;
}

const UTIL_PREC = 100_000n; // VariableInterestRate / LightlendPairConstants.UTIL_PREC
const RATE_PREC = 10n ** 18n;

const RATE_CALCULATOR = Object.freeze({
  suffix: "Lighter devnet 0% | 25-100% full (start 50%) | vertex 80% @ 10% | target 70-85% | 2d",
  vertexUtilization: 80_000n, // 80%
  vertexRatePercentOfDelta: RATE_PREC / 10n, // 10% of (full - zero)
  minUtil: 70_000n, // 70%
  maxUtil: 85_000n, // 85%
  zeroUtilizationRate: 0n, // 0% APR
  minFullUtilizationRate: aprBpsToRatePerSec(2_500), // 25% APR
  maxFullUtilizationRate: aprBpsToRatePerSec(10_000), // 100% APR
  rateHalfLife: 172_800n, // 2 days
});

/** VariableInterestRate constructor arguments, in order. */
function rateCalculatorArgs(c = RATE_CALCULATOR) {
  return [
    c.suffix,
    c.vertexUtilization,
    c.vertexRatePercentOfDelta,
    c.minUtil,
    c.maxUtil,
    c.zeroUtilizationRate,
    c.minFullUtilizationRate,
    c.maxFullUtilizationRate,
    c.rateHalfLife,
  ];
}

/** The calculator's immutables (getter name -> expected value), read back after deployment. */
function rateCalculatorImmutables(c = RATE_CALCULATOR) {
  return {
    VERTEX_UTILIZATION: c.vertexUtilization,
    VERTEX_RATE_PERCENT: c.vertexRatePercentOfDelta,
    MIN_TARGET_UTIL: c.minUtil,
    MAX_TARGET_UTIL: c.maxUtil,
    ZERO_UTIL_RATE: c.zeroUtilizationRate,
    MIN_FULL_UTIL_RATE: c.minFullUtilizationRate,
    MAX_FULL_UTIL_RATE: c.maxFullUtilizationRate,
    RATE_HALF_LIFE: c.rateHalfLife,
  };
}

/** Pair config values that the manifest does not carry (same for both pairs). */
const PAIR = Object.freeze({
  // LighterDualOracle returns priceLow == priceHigh, so the deviation is always 0; the bound only
  // matters if the timelock ever swaps in another oracle. 5% (1e5 precision), as FraxLend defaults.
  maxOracleDeviation: 5_000n,
  // Starting full-utilization rate: 50% APR (adapts within the calculator's 25-100% APR).
  fullUtilizationRate: aprBpsToRatePerSec(5_000),
});

/** Manifest basis points -> the pair's 1e5 precision (LightlendPairConstants: bps x 10). */
function bpsTo1e5(bps) {
  return BigInt(bps) * 10n;
}

/** 1e5 precision -> basis points; throws unless exact. */
function e5ToBps(value, label) {
  const v = BigInt(value);
  if (v % 10n !== 0n) throw new Error(`${label} ${v} (1e5 precision) is not a whole number of basis points`);
  return Number(v / 10n);
}

/**
 * The pair `_configData` (LightlendPairDeployer.deploy / LightlendPairCore constructor):
 * abi.encode(asset, collateral, oracle, maxOracleDeviation, rateContract, fullUtilizationRate,
 * maxLTV, cleanLiquidationFee, protocolLiquidationFee). The dirty fee is derived by the constructor
 * (90% of clean) and is not encoded.
 */
const CONFIG_TYPES = ["address", "address", "address", "uint32", "address", "uint64", "uint256", "uint256", "uint256"];

function encodePairConfig(abiCoder, p) {
  return abiCoder.encode(CONFIG_TYPES, [
    p.asset,
    p.collateral,
    p.oracle,
    p.maxOracleDeviation,
    p.rateContract,
    p.fullUtilizationRate,
    p.maxLTV,
    p.cleanLiquidationFee,
    p.protocolLiquidationFee,
  ]);
}

function decodePairConfig(abiCoder, data) {
  const v = abiCoder.decode(CONFIG_TYPES, data);
  return {
    asset: v[0],
    collateral: v[1],
    oracle: v[2],
    maxOracleDeviation: BigInt(v[3]),
    rateContract: v[4],
    fullUtilizationRate: BigInt(v[5]),
    maxLTV: BigInt(v[6]),
    cleanLiquidationFee: BigInt(v[7]),
    protocolLiquidationFee: BigInt(v[8]),
  };
}

/**
 * Simulates `getNewRate` on a deployed calculator (eth_call) at 0%, the vertex and 100%
 * utilization, for elapsed times from 1 s to 10 years and full-utilization rates at the start
 * value, both clamps and the uint64 extremes. Throws unless every call returns and the results are
 * consistent: new full rate within [min, max], rate at 0% = ZERO_UTIL_RATE, rate at the vertex =
 * the vertex rate, rate at 100% = the new full rate, and rates non-decreasing in utilization.
 * Returns the rows (bigints) for reporting.
 */
async function simulateRates(calculator, c = RATE_CALCULATOR, startFullRate = PAIR.fullUtilizationRate) {
  const U64_MAX = 2n ** 64n - 1n;
  const utils = [0n, c.vertexUtilization, UTIL_PREC];
  const deltas = [1n, 3_600n, 86_400n, 10n * 365n * 86_400n];
  const fulls = [...new Set([startFullRate, c.minFullUtilizationRate, c.maxFullUtilizationRate, 1n, U64_MAX])];
  const rows = [];
  for (const dt of deltas) {
    for (const full of fulls) {
      const rates = [];
      for (const u of utils) {
        let rate;
        let newFull;
        try {
          [rate, newFull] = await calculator.getNewRate(dt, u, full);
        } catch (err) {
          throw new Error(`getNewRate(${dt}, ${u}, ${full}) reverted: ${err.shortMessage ?? err.message}`);
        }
        rate = BigInt(rate);
        newFull = BigInt(newFull);
        if (newFull < c.minFullUtilizationRate || newFull > c.maxFullUtilizationRate) {
          throw new Error(`getNewRate(${dt}, ${u}, ${full}): new full rate ${newFull} outside [${c.minFullUtilizationRate}, ${c.maxFullUtilizationRate}]`);
        }
        const vertexRate = ((newFull - c.zeroUtilizationRate) * c.vertexRatePercentOfDelta) / RATE_PREC + c.zeroUtilizationRate;
        const expected = u === 0n ? c.zeroUtilizationRate : u === UTIL_PREC ? newFull : vertexRate;
        if (rate !== expected) throw new Error(`getNewRate(${dt}, ${u}, ${full}): rate ${rate}, expected ${expected}`);
        rates.push(rate);
        rows.push({ deltaTime: dt, utilization: u, fullRateIn: full, ratePerSec: rate, newFullRate: newFull });
      }
      if (!(rates[0] <= rates[1] && rates[1] <= rates[2])) throw new Error(`getNewRate(${dt}, *, ${full}): rates not increasing with utilization`);
    }
  }
  return rows;
}

module.exports = {
  SECONDS_PER_YEAR,
  UTIL_PREC,
  RATE_CALCULATOR,
  PAIR,
  aprBpsToRatePerSec,
  ratePerSecToAprPercent,
  rateCalculatorArgs,
  rateCalculatorImmutables,
  bpsTo1e5,
  e5ToBps,
  encodePairConfig,
  decodePairConfig,
  simulateRates,
};
