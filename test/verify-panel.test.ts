import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { encodeEventTopics, encodeFunctionData, parseAbi } from "viem";
import { canonicalForecast, commitmentFor } from "../src/canonical.js";
import { forecastRootEmitterAbi } from "../src/emitter.js";
import {
  BINARY_MARKET_SIGNATURES,
  BINARY_MODULE_MARKETS_SIGNATURE,
  createAnchorReader,
  createJsonRpc,
  createMarketReader,
  describeVerification,
  EXPECTED_SUBMITTER,
  explorerTransactionUrl,
  inputFailure,
  parseEvidenceJson,
  verifyEvidenceInBrowser,
  type FetchLike,
  type JsonRpc,
} from "../dashboard/app/verify-chain-browser.js";
import { selectMirroredFiles, FLAGSHIP_FILE } from "../scripts/lib/evidence-mirror.js";
import type { ChainAnchorReader, ChainMarketReader } from "../src/evidence-verifier.js";
import type { EvidenceManifest, Hex32, PublishedForecastEvidence } from "../src/types.js";

const fixtureFile = resolve(`evidence/${FLAGSHIP_FILE}`);
const fixture = JSON.parse(await readFile(fixtureFile, "utf8")) as PublishedForecastEvidence;
const ANCHOR_BLOCK_HASH = "0xb8353b1852fd10b80fa231b8d961240368553d8341ff18e19c2bc0dc56974e05";
const MARKET_CONTRACT = "0x6D780D763d958b87fb078b14c1c4615666258D17";

const word = (value: bigint | string): string => typeof value === "bigint"
  ? value.toString(16).padStart(64, "0")
  : value.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * The live receipt for this fixture, rebuilt from the emitter ABI so a change to
 * the event shape breaks the stub instead of being papered over by a constant.
 */
const RECEIPT_LOG = {
  address: "0x3020c7ea249b6be98d0e9acf911eaeeb766ace4f",
  topics: encodeEventTopics({
    abi: forecastRootEmitterAbi,
    eventName: "RootAnchored",
    args: { root: fixture.root, submitter: EXPECTED_SUBMITTER },
  }),
  data: `0x${word(4n)}`,
};

/** markets(bytes32): 14 words, the market contract at index 8 and expiry at 13. */
function moduleRecord(marketAddress: string, expiry: bigint): string {
  const words = Array.from({ length: 14 }, () => word(0n));
  words[8] = word(marketAddress);
  words[13] = word(expiry);
  return `0x${words.join("")}`;
}

const marketAbi = parseAbi([...BINARY_MARKET_SIGNATURES]);
const selector = (functionName: "payoutNumerators" | "isResolved" | "isVoided"): string =>
  encodeFunctionData({ abi: marketAbi, functionName }).slice(0, 10);

/**
 * A JSON-RPC stub over the four methods the readers use. Every response body is
 * shaped like the live node's, so the decoding path under test is the real one.
 */
function stubRpc(overrides: Partial<{
  receipt: unknown;
  block: unknown;
  moduleRecord: string;
  payoutNumerators: string;
  isResolved: string;
  isVoided: string;
}> = {}): { rpc: JsonRpc; calls: string[] } {
  const calls: string[] = [];
  const rpc: JsonRpc = async (method, params) => {
    calls.push(method);
    if (method === "eth_getTransactionReceipt") {
      return overrides.receipt !== undefined ? overrides.receipt : {
        status: "0x1",
        blockHash: ANCHOR_BLOCK_HASH,
        logs: [RECEIPT_LOG],
      };
    }
    if (method === "eth_getBlockByHash") {
      return overrides.block !== undefined ? overrides.block : { timestamp: "0x6a8dcbbd" };
    }
    if (method === "eth_call") {
      const request = params[0] as { to: string; data: string };
      if (request.to.toLowerCase() !== MARKET_CONTRACT.toLowerCase()) {
        return overrides.moduleRecord ?? moduleRecord(MARKET_CONTRACT, 1_787_680_800n);
      }
      // payoutNumerators() -> [1e7, 0]; isResolved() -> true; isVoided() -> false.
      if (request.data.startsWith(selector("payoutNumerators"))) {
        return overrides.payoutNumerators
          ?? `0x${word(32n)}${word(2n)}${word(10_000_000n)}${word(0n)}`;
      }
      if (request.data.startsWith(selector("isResolved"))) return overrides.isResolved ?? `0x${word(1n)}`;
      if (request.data.startsWith(selector("isVoided"))) return overrides.isVoided ?? `0x${word(0n)}`;
    }
    throw new Error(`unexpected call ${method}`);
  };
  return { rpc, calls };
}

test("browser anchor reader decodes a RootAnchored receipt and the block timestamp", async () => {
  const { rpc, calls } = stubRpc();
  const anchor = await createAnchorReader(rpc)(fixture.anchor_tx);
  assert.deepEqual(calls, ["eth_getTransactionReceipt", "eth_getBlockByHash"]);
  assert.equal(anchor.blockTimestamp, 1_787_677_629n);
  assert.equal(anchor.events.length, 1);
  assert.equal(anchor.events[0]?.root, fixture.root);
  assert.equal(anchor.events[0]?.leafCount, 4n);
  assert.equal(anchor.events[0]?.submitter, EXPECTED_SUBMITTER);
});

test("browser anchor reader caches one receipt per transaction", async () => {
  const { rpc, calls } = stubRpc();
  const read = createAnchorReader(rpc);
  await Promise.all([read(fixture.anchor_tx), read(fixture.anchor_tx)]);
  assert.deepEqual(calls, ["eth_getTransactionReceipt", "eth_getBlockByHash"]);
});

test("browser anchor reader rejects a reverted anchor and a missing receipt", async () => {
  await assert.rejects(
    createAnchorReader(stubRpc({ receipt: { status: "0x0", blockHash: ANCHOR_BLOCK_HASH, logs: [] } }).rpc)(fixture.anchor_tx),
    /anchor transaction reverted/,
  );
  await assert.rejects(
    createAnchorReader(stubRpc({ receipt: null }).rpc)(fixture.anchor_tx),
    /not found on this RPC/,
  );
});

test("browser anchor reader ignores logs from other contracts", async () => {
  const foreign = { ...RECEIPT_LOG, address: "0x0000000000000000000000000000000000000001" };
  const { rpc } = stubRpc({ receipt: { status: "0x1", blockHash: ANCHOR_BLOCK_HASH, logs: [foreign] } });
  await assert.rejects(createAnchorReader(rpc)(fixture.anchor_tx), /RootAnchored event missing/);
});

test("browser market reader resolves the module record and the payout vector", async () => {
  const { rpc, calls } = stubRpc();
  const market = await createMarketReader(rpc)(fixture.market_id);
  assert.equal(market.marketId, fixture.market_id);
  assert.equal(market.expiry, 1_787_680_800n);
  assert.equal(market.expiry * 1_000_000_000n, BigInt(fixture.preimage.expiry_ns));
  assert.equal(market.winningOutcome, 0);
  assert.equal(market.isResolved, true);
  assert.equal(market.isVoided, false);
  // One module read, then the three market reads in parallel.
  assert.equal(calls.filter((method) => method === "eth_call").length, 4);
});

test("browser market reader rejects a market the module never registered", async () => {
  const { rpc } = stubRpc({ moduleRecord: moduleRecord("0x0000000000000000000000000000000000000000", 0n) });
  await assert.rejects(createMarketReader(rpc)("0x00".padEnd(66, "f") as Hex32), /unknown marketId .* on the module/);
});

test("JSON-RPC transport reports HTTP status, RPC errors and unreachable hosts", async () => {
  const ok: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ result: "0x1" }) });
  assert.equal(await createJsonRpc("https://rpc.invalid", ok)("eth_chainId", []), "0x1");

  const http500: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(createJsonRpc("https://rpc.invalid", http500)("eth_chainId", []), /returned HTTP 500/);

  const rpcError: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "boom" } }) });
  await assert.rejects(createJsonRpc("https://rpc.invalid", rpcError)("eth_chainId", []), /eth_chainId failed: boom/);

  const dead: FetchLike = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(createJsonRpc("https://rpc.invalid", dead)("eth_chainId", []), /could not reach https:\/\/rpc.invalid/);
});

test("JSON-RPC transport sends one well-formed request per call", async () => {
  const sent: string[] = [];
  const capture: FetchLike = async (url, init) => {
    assert.equal(url, "https://rpc.example/somnia");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    sent.push(init.body);
    return { ok: true, status: 200, json: async () => ({ result: null }) };
  };
  const rpc = createJsonRpc("https://rpc.example/somnia", capture);
  await rpc("eth_call", [{ to: "0x1", data: "0x2" }, "latest"]);
  await rpc("eth_chainId", []);
  assert.deepEqual(sent.map((body) => JSON.parse(body)), [
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x1", data: "0x2" }, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] },
  ]);
});

const stubbedReaders = (): { readAnchor: ChainAnchorReader; readMarket: ChainMarketReader } => {
  const { rpc } = stubRpc();
  return { readAnchor: createAnchorReader(rpc), readMarket: createMarketReader(rpc) };
};

test("panel verdict: the flagship forecast PASSes all five steps", async () => {
  const result = await verifyEvidenceInBrowser(fixture, stubbedReaders());
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.equal(result.inputError, null);
  assert.equal(result.steps[0]?.line, `PASS 1/5 canonical preimage -> ${fixture.commitment}`);
  assert.equal(result.steps[1]?.line, `PASS 2/5 Merkle proof -> ${fixture.root}`);
  assert.equal(
    result.steps[2]?.line,
    `PASS 3/5 agent ${EXPECTED_SUBMITTER} emitted root with leafCount 4 at block timestamp 1787677629`,
  );
  assert.equal(
    result.steps[3]?.line,
    `PASS 4/5 on-chain market ${fixture.market_id} expiry_ns ${fixture.preimage.expiry_ns} outcome YES`,
  );
  assert.equal(result.steps[4]?.line, `PASS 5/5 anchor_ns 1787677629000000000 < on-chain expiry_ns ${fixture.preimage.expiry_ns}`);
  assert.equal(result.anchorTx, fixture.anchor_tx);
  assert.equal(result.explorerUrl, `https://shannon-explorer.somnia.network/tx/${fixture.anchor_tx}`);
  for (const step of result.steps) assert.ok(step.explanation.length > 0);
});

test("panel verdict: one changed probability digit FAILs at the commitment", async () => {
  const tampered = structuredClone(fixture);
  tampered.preimage.p_agent = 0.2214;
  const result = await verifyEvidenceInBrowser(tampered, stubbedReaders());
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.steps[0]?.status, "FAIL");
  assert.match(result.steps[0]?.line ?? "", /^FAIL 1\/5 .*canonical_preimage/);
  // Nothing after the deciding step is claimed to have run.
  assert.deepEqual(result.steps.slice(1).map((step) => step.status), ["NOT RUN", "NOT RUN", "NOT RUN", "NOT RUN"]);
});

test("panel verdict: a resealed probability digit FAILs at the Merkle step", async () => {
  // A forger who also recomputes canonical_preimage, commitment and the sealed
  // risk decision gets past step 1. The anchored root still refuses the leaf.
  const tampered = structuredClone(fixture);
  tampered.preimage.p_agent = 0.2214;
  tampered.canonical_preimage = canonicalForecast(tampered.preimage);
  tampered.commitment = commitmentFor(tampered.preimage);
  tampered.risk_decision = { ...tampered.risk_decision!, absolute_edge_e4: 1021 };
  const result = await verifyEvidenceInBrowser(tampered, stubbedReaders());
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "FAIL", "NOT RUN", "NOT RUN", "NOT RUN"]);
  assert.equal(result.steps[1]?.line, "FAIL 2/5 Merkle proof does not produce the published root");
});

test("panel verdict: a foreign anchor_tx FAILs at the anchor step", async () => {
  const foreignTransaction = "0xaf9a9b6e7faa6283e8e6a1dcf195b6e21885c2747181206ed76d83f355111f1e" as Hex32;
  const foreignRoot = "0x5e759f913317c47f705c2df93b88c317872422d633471dcb7a1d642a512ef094" as Hex32;
  const tampered = structuredClone(fixture);
  tampered.anchor_tx = foreignTransaction;
  const { readMarket } = stubbedReaders();
  const result = await verifyEvidenceInBrowser(tampered, {
    readMarket,
    readAnchor: async (transactionHash) => {
      assert.equal(transactionHash, foreignTransaction);
      return {
        events: [{ root: foreignRoot, leafCount: 1n, submitter: EXPECTED_SUBMITTER }],
        blockTimestamp: 1_787_676_797n,
      };
    },
  });
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "FAIL", "NOT RUN", "NOT RUN"]);
  assert.match(result.steps[2]?.line ?? "", /^FAIL 3\/5 on-chain root does not match/);
  // The explorer link still points at the transaction the file claims.
  assert.equal(result.explorerUrl, explorerTransactionUrl(foreignTransaction));
});

test("panel verdict: a late anchor is NOT PROVABLE, never FAIL", async () => {
  const result = describeVerification(fixture, {
    status: "NOT PROVABLE",
    steps: [
      { step: 1, status: "PASS", message: `canonical preimage -> ${fixture.commitment}` },
      { step: 2, status: "PASS", message: `Merkle proof -> ${fixture.root}` },
      { step: 3, status: "PASS", message: "agent x emitted root with leafCount 4 at block timestamp 3" },
      { step: 4, status: "PASS", message: "on-chain market x expiry_ns 2000000000 outcome YES" },
      { step: 5, status: "NOT PROVABLE", message: "anchor_ns 3000000000 is not before on-chain expiry_ns 2000000000" },
    ],
  });
  assert.equal(result.verdict, "NOT PROVABLE");
  assert.equal(result.steps[4]?.status, "NOT PROVABLE");
  assert.equal(result.steps[4]?.line, "NOT PROVABLE 5/5 anchor_ns 3000000000 is not before on-chain expiry_ns 2000000000");
});

test("panel verdict: a dead RPC surfaces as a step FAIL, matching the CLI", async () => {
  const dead: FetchLike = async () => { throw new TypeError("Failed to fetch"); };
  const result = await verifyEvidenceInBrowser(fixture, { rpcUrl: "https://rpc.invalid", fetchImpl: dead });
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.steps.map((step) => step.status), ["PASS", "PASS", "FAIL", "NOT RUN", "NOT RUN"]);
  assert.match(result.steps[2]?.line ?? "", /could not reach https:\/\/rpc.invalid/);
});

test("panel verdict: unparsable input mirrors the CLI's FAIL input line", () => {
  assert.throws(() => parseEvidenceJson("not json"));
  assert.throws(() => parseEvidenceJson("[1,2]"), /evidence must be a JSON object/);
  const result = inputFailure("Unexpected token o in JSON at position 1");
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.anchorTx, null);
  assert.equal(result.explorerUrl, null);
  assert.deepEqual(result.steps.map((step) => step.status), ["NOT RUN", "NOT RUN", "NOT RUN", "NOT RUN", "NOT RUN"]);
});

test("panel never invents a verdict outside the CLI's three", async () => {
  const verdicts = new Set<string>();
  verdicts.add((await verifyEvidenceInBrowser(fixture, stubbedReaders())).verdict);
  verdicts.add(inputFailure("x").verdict);
  const tampered = structuredClone(fixture);
  tampered.outcome = "NO";
  verdicts.add((await verifyEvidenceInBrowser(tampered, stubbedReaders())).verdict);
  for (const verdict of verdicts) assert.ok(["PASS", "FAIL", "NOT PROVABLE"].includes(verdict), verdict);
});

test("market read signatures still match the installed markets SDK", async () => {
  const moduleAbi = await readFile(resolve("node_modules/@somnia-chain/markets-sdk/dist/moduleAbi.js"), "utf8");
  const readsAbi = await readFile(resolve("node_modules/@somnia-chain/markets-sdk/dist/readsAbi.js"), "utf8");
  assert.ok(moduleAbi.includes(BINARY_MODULE_MARKETS_SIGNATURE), "markets(bytes32) tuple drifted from the SDK");
  for (const signature of BINARY_MARKET_SIGNATURES) {
    assert.ok(readsAbi.includes(signature), `${signature} drifted from the SDK`);
  }
});

test("evidence mirror selects the flagship plus the newest N, deterministically", () => {
  const entry = (file: string): EvidenceManifest["entries"][number] => ({
    leaf_index: 0,
    file,
    root: "0x00" as Hex32,
    anchor_tx: "0x00" as Hex32,
    anchored_late: false,
  });
  const manifest: EvidenceManifest = {
    entries: [
      entry(FLAGSHIP_FILE),
      entry("0xaa-300.json"),
      entry("0xbb-100.json"),
      entry("0xcc-200.json"),
    ],
    totals: { total: 4, provable: 4, anchored_late: 0 },
  };
  assert.deepEqual(selectMirroredFiles(manifest, 2), [FLAGSHIP_FILE, "0xaa-300.json", "0xcc-200.json"]);
  // Same manifest in a different order mirrors the same files in the same order.
  const shuffled: EvidenceManifest = { ...manifest, entries: [...manifest.entries].reverse() };
  assert.deepEqual(selectMirroredFiles(shuffled, 2), selectMirroredFiles(manifest, 2));
  // The flagship is kept however old it is, and N never grows the selection.
  assert.equal(selectMirroredFiles(manifest, 99).length, 4);
  assert.equal(selectMirroredFiles(manifest, 0)[0], FLAGSHIP_FILE);
  assert.equal(selectMirroredFiles(manifest, 0).length, 1);
  // A manifest without the flagship mirrors N recent files and nothing else.
  const withoutFlagship: EvidenceManifest = {
    ...manifest,
    entries: manifest.entries.filter((item) => item.file !== FLAGSHIP_FILE),
  };
  assert.deepEqual(selectMirroredFiles(withoutFlagship, 2), ["0xaa-300.json", "0xcc-200.json"]);
});

test("the mirrored index matches the mirrored bodies and includes the flagship", async () => {
  const directory = resolve("dashboard/public/evidence");
  const index = JSON.parse(await readFile(resolve(directory, "index.json"), "utf8")) as {
    flagship: string;
    entries: Array<{ file: string; market_id: string; anchor_tx: string; flagship: boolean }>;
  };
  assert.equal(index.flagship, FLAGSHIP_FILE);
  assert.equal(index.entries.filter((item) => item.flagship).length, 1);
  assert.equal(index.entries[0]?.file, FLAGSHIP_FILE);
  for (const item of index.entries) {
    const body = JSON.parse(await readFile(resolve(directory, item.file), "utf8")) as PublishedForecastEvidence;
    assert.equal(body.market_id, item.market_id);
    assert.equal(body.anchor_tx, item.anchor_tx);
    // Every mirrored file must be verifiable without a ledger.
    assert.ok(body.risk_decision !== undefined, `${item.file} has no risk_decision`);
    assert.ok(body.leaf_count !== undefined, `${item.file} has no leaf_count`);
  }
});
