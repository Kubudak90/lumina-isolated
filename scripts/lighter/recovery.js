// Crash recovery and log helpers for scripts/deploy-lighter-isolated.js (S5c fix round 1, same
// write-ahead mechanism as the S4c deploy).
//
// Write-ahead record: before every CREATE or state-changing transaction the script writes one
// pending record into the deploy checkpoint (the sidecar <state>/deploy-checkpoint.json, key
// `isolatedPending`; only `isolated*` keys are written here, the rest of the file is kept as is):
//   { step, kind: "create" | "call", label, sourceCommit, chainId, deployer, nonce, fromBlock,
//     dataHash, to (call), expectedAddress (CREATE address, or the pair a deploy() creates), hash? }
// The record is cleared once the transaction's result is verified and published (a CREATE only
// after the contract's own checks pass and its manifest entry is written). A rerun that finds a
// record reconciles it with the chain (reconcilePending) before sending anything.

const fs = require("node:fs");

const PENDING_KEY = "isolatedPending";

/** The deploy checkpoint, read and written whole (atomic temp file + rename); only isolated* keys change. */
class Checkpoint {
  constructor(file, { noop = false } = {}) {
    this.file = file;
    this.noop = noop;
  }

  read() {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
  }

  write(data) {
    if (this.noop) throw new Error(`no-op mode: refusing to change the deploy checkpoint ${this.file}`);
    for (const key of Object.keys(data)) {
      if (!key.startsWith("isolated") && JSON.stringify(data[key]) !== JSON.stringify(this.read()[key])) {
        throw new Error(`refusing to change the non-isolated checkpoint key ${key}`);
      }
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  get pending() {
    return this.read()[PENDING_KEY] ?? null;
  }

  setPending(record) {
    const data = this.read();
    if (data[PENDING_KEY]) throw new Error(`a pending record already exists (${data[PENDING_KEY].step}); reconcile it first`);
    data[PENDING_KEY] = record;
    this.write(data);
  }

  updatePending(fields) {
    const data = this.read();
    if (!data[PENDING_KEY]) throw new Error("no pending record to update");
    data[PENDING_KEY] = { ...data[PENDING_KEY], ...fields };
    this.write(data);
  }

  clearPending() {
    const data = this.read();
    if (!(PENDING_KEY in data)) return;
    delete data[PENDING_KEY];
    this.write(data);
  }
}

/**
 * eth_getLogs over [fromBlock, toBlock] in chunks of `range` blocks; a refused chunk is halved down
 * to one block before the error is rethrown (as scripts/snapshot-roles.mjs getLogsChunked). After
 * a success the chunk size goes back to `range`. Sorted by block and log index.
 */
async function getLogsChunked(provider, filter, fromBlock, toBlock, range = 5_000) {
  const out = [];
  let start = Number(fromBlock);
  const to = Number(toBlock);
  let size = range;
  while (start <= to) {
    const end = Math.min(to, start + size - 1);
    try {
      out.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
      start = end + 1;
      size = range;
    } catch (err) {
      if (size === 1) throw err;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return out.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.index ?? a.logIndex) - Number(b.index ?? b.logIndex));
}

/**
 * The deployer's mined transaction with `nonce`: by the recorded hash when there is one, else by
 * scanning blocks from `fromBlock` (the record's block; the transaction cannot be earlier) up to
 * `maxBlocks` blocks. Returns null if it is not found.
 */
async function findTxByNonce(provider, { deployer, nonce, hash, fromBlock }, { maxBlocks = 20_000 } = {}) {
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (hash) {
    const tx = await provider.getTransaction(hash);
    if (tx && tx.blockNumber !== null && same(tx.from, deployer) && Number(tx.nonce) === Number(nonce)) return tx;
  }
  const latest = await provider.getBlockNumber();
  const last = Math.min(latest, Number(fromBlock) + maxBlocks);
  for (let n = Number(fromBlock); n <= last; n++) {
    const block = await provider.getBlock(n, true);
    for (const tx of block?.prefetchedTransactions ?? []) {
      if (same(tx.from, deployer) && Number(tx.nonce) === Number(nonce)) return tx;
    }
  }
  return null;
}

/**
 * True for a contract revert, false for transport and other errors: ethers' CALL_EXCEPTION, or the
 * node's JSON-RPC execution error (EIP-1474 code 3, or -32000 "execution reverted"), which is how
 * hardhat-ethers surfaces a revert from an HTTP node.
 */
function isContractRevert(err) {
  if (err?.code === "CALL_EXCEPTION") return true;
  return (err?.code === 3 || err?.code === -32000) && /execution reverted/i.test(err?.message ?? "");
}

module.exports = { Checkpoint, PENDING_KEY, getLogsChunked, findTxByNonce, isContractRevert };
