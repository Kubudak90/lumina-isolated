// S5c fix round 1: the helpers behind the write-ahead crash recovery and the log queries of
// scripts/deploy-lighter-isolated.js (scripts/lighter/recovery.js). The end-to-end interruption
// tests run against the harness (lumina-monorepo harness/deploy/isolated.mjs --recovery-tests).
const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const R = require("../scripts/lighter/recovery");

/** A provider whose eth_getLogs refuses ranges wider than `limit` blocks (like a public RPC). */
function rangeLimitedProvider(logs, limit) {
    const calls = [];
    return {
        calls,
        async getLogs({ fromBlock, toBlock }) {
            calls.push([fromBlock, toBlock]);
            if (toBlock - fromBlock + 1 > limit) throw new Error(`block range too large (max ${limit})`);
            return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
        },
    };
}

describe("Lighter isolated deploy: recovery helpers (S5c)", function () {
    describe("getLogsChunked", function () {
        const logs = [5, 1_234, 9_999, 10_000, 25_001, 40_000].map((b, i) => ({ blockNumber: b, index: i % 2, id: b }));

        it("returns every log of a wide range from an RPC that refuses ranges over N blocks", async function () {
            const provider = rangeLimitedProvider(logs, 1_000);
            const out = await R.getLogsChunked(provider, { address: "0x01" }, 0, 40_000, 5_000);
            expect(out.map((l) => l.id)).to.deep.equal(logs.map((l) => l.id));
            // Ranges were halved below the limit and every block was covered exactly once.
            const ok = provider.calls.filter(([a, b]) => b - a + 1 <= 1_000);
            let next = 0;
            for (const [a, b] of ok) {
                expect(a).to.equal(next);
                next = b + 1;
            }
            expect(next).to.equal(40_001);
        });

        it("a single query when the RPC accepts the range; sorted by block and log index", async function () {
            const shuffled = [{ blockNumber: 7, index: 2 }, { blockNumber: 3, index: 0 }, { blockNumber: 7, index: 1 }];
            const provider = { calls: 0, async getLogs() { this.calls++; return shuffled; } };
            const out = await R.getLogsChunked(provider, {}, 0, 100, 5_000);
            expect(provider.calls).to.equal(1);
            expect(out.map((l) => `${l.blockNumber}:${l.index}`)).to.deep.equal(["3:0", "7:1", "7:2"]);
        });

        it("rethrows once a single-block query is refused", async function () {
            const provider = { async getLogs() { throw new Error("rpc down"); } };
            let err = null;
            try {
                await R.getLogsChunked(provider, {}, 0, 10, 4);
            } catch (e) {
                err = e;
            }
            expect(err?.message).to.equal("rpc down");
        });
    });

    describe("Checkpoint (write-ahead record)", function () {
        let dir;
        let file;
        beforeEach(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "s5c-cp-"));
            file = path.join(dir, "deploy-checkpoint.json");
            fs.writeFileSync(file, `${JSON.stringify({ environment: "lighter-devnet", chainId: 19529, safeProbe: { queueTx: "0x01" }, exercised: { block: 9 } }, null, 2)}\n`);
        });
        afterEach(function () {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it("sets, updates and clears isolatedPending and keeps every other key as it was", function () {
            const cp = new R.Checkpoint(file);
            expect(cp.pending).to.equal(null);
            cp.setPending({ step: "create:isolatedTimelock", nonce: 7 });
            cp.updatePending({ hash: "0xabc" });
            expect(cp.pending).to.deep.equal({ step: "create:isolatedTimelock", nonce: 7, hash: "0xabc" });
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            expect(data.safeProbe).to.deep.equal({ queueTx: "0x01" });
            expect(data.exercised).to.deep.equal({ block: 9 });
            cp.clearPending();
            expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")))).to.deep.equal(["environment", "chainId", "safeProbe", "exercised"]);
        });

        it("refuses a second record while one is pending", function () {
            const cp = new R.Checkpoint(file);
            cp.setPending({ step: "a" });
            expect(() => cp.setPending({ step: "b" })).to.throw(/already exists/);
        });

        it("refuses to change a key that is not isolated* (S4c's records stay untouched)", function () {
            const cp = new R.Checkpoint(file);
            const before = fs.readFileSync(file, "utf8");
            const data = cp.read();
            expect(() => cp.write({ ...data, safeProbe: { queueTx: "0x02" } })).to.throw(/non-isolated checkpoint key safeProbe/);
            expect(fs.readFileSync(file, "utf8")).to.equal(before);
            cp.write({ ...data, isolatedSafeHandover: [] });
            expect(cp.read().safeProbe).to.deep.equal({ queueTx: "0x01" });
        });

        it("in no-op mode refuses to write at all", function () {
            const before = fs.readFileSync(file, "utf8");
            const cp = new R.Checkpoint(file, { noop: true });
            expect(() => cp.setPending({ step: "a" })).to.throw(/no-op mode/);
            expect(fs.readFileSync(file, "utf8")).to.equal(before);
        });
    });

    describe("findTxByNonce", function () {
        const deployer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        const tx = (nonce, from = deployer, block = 12) => ({ from, nonce, blockNumber: block, hash: `0x${nonce}` });
        const provider = {
            async getTransaction(hash) {
                return hash === "0x5" ? tx(5) : null;
            },
            async getBlockNumber() {
                return 14;
            },
            async getBlock(n) {
                return { prefetchedTransactions: n === 12 ? [tx(4, "0x0000000000000000000000000000000000000001"), tx(4)] : [] };
            },
        };

        it("by the recorded hash, else by scanning blocks from the record's block", async function () {
            expect((await R.findTxByNonce(provider, { deployer, nonce: 5, hash: "0x5", fromBlock: 10 })).hash).to.equal("0x5");
            expect((await R.findTxByNonce(provider, { deployer, nonce: 4, fromBlock: 10 })).from).to.equal(deployer);
            expect(await R.findTxByNonce(provider, { deployer, nonce: 6, fromBlock: 10 })).to.equal(null);
        });
    });

    it("isContractRevert: a contract revert (ethers or JSON-RPC execution error), never a transport error", function () {
        expect(R.isContractRevert({ code: "CALL_EXCEPTION" })).to.equal(true);
        expect(R.isContractRevert({ name: "ProviderError", code: 3, message: "execution reverted", data: "0x" })).to.equal(true);
        expect(R.isContractRevert({ code: -32000, message: "execution reverted" })).to.equal(true);
        expect(R.isContractRevert({ code: -32000, message: "header not found" })).to.equal(false);
        expect(R.isContractRevert({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8545" })).to.equal(false);
        expect(R.isContractRevert({ code: "NETWORK_ERROR" })).to.equal(false);
        expect(R.isContractRevert({ code: "TIMEOUT" })).to.equal(false);
        expect(R.isContractRevert(new Error("socket hang up"))).to.equal(false);
    });
});
