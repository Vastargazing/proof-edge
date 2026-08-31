import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  type PublicClient,
} from "viem";
import { createExchange, shutdown } from "@dreamdex-bot-kit/ec-core";
import { verifyPublishedEvidence } from "../src/evidence-verifier.js";
import {
  forecastRootEmitterAbi,
  LEDGER_HEAD_EMITTER_ADDRESS,
  LEGACY_EMITTER_ADDRESS,
  RECORDER_SUBMITTER_ADDRESS,
} from "../src/emitter.js";
import { AppendOnlyStore } from "../src/store.js";
import type { Hex32, PublishedForecastEvidence } from "../src/types.js";
import { anchorLeadLines, evidenceAnchorLead, resolveMinAnchorLeadSec } from "./lib/anchor-lead.js";

const DEFAULT_RPC = "https://api.infra.testnet.somnia.network";
const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC;
const minAnchorLeadSec = resolveMinAnchorLeadSec(process.env.MIN_ANCHOR_LEAD_SEC);
const emitters = (process.env.EMITTER_ADDRESSES
  ?? process.env.EMITTER_ADDRESS
  ?? `${LEGACY_EMITTER_ADDRESS},${LEDGER_HEAD_EMITTER_ADDRESS}`)
  .split(",").map((address) => getAddress(address.trim()));
const emitterSet = new Set(emitters.map((address) => address.toLowerCase()));
const expectedSubmitter = getAddress(process.env.SUBMITTER_ADDRESS ?? RECORDER_SUBMITTER_ADDRESS);
const chain = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const exchangeContext = createExchange({ withSigner: false });

type ResultStatus = "PASS" | "NOT PROVABLE" | "FAIL";
interface VerificationResult {
  file: string;
  status: ResultStatus;
  /** Annotation only. Never read when deciding `status`. */
  lowLead: boolean;
}

type ReadAnchor = Awaited<ReturnType<typeof readAnchorFromChain>>;
const anchorCache = new Map<Hex32, Promise<ReadAnchor>>();

async function readAnchorFromChain(
  publicClient: PublicClient,
  transactionHash: Hex32,
): Promise<{
  events: Array<{ root: Hex32; leafCount: bigint; submitter: string }>;
  blockTimestamp: bigint;
}> {
  const cached = anchorCache.get(transactionHash);
  if (cached) return cached;
  const pending = (async () => {
    const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("anchor transaction reverted");
    const events: Array<{ root: Hex32; leafCount: bigint; submitter: string }> = [];
    for (const entry of receipt.logs) {
      if (!emitterSet.has(entry.address.toLowerCase())) continue;
      try {
        const decoded = decodeEventLog({ abi: forecastRootEmitterAbi, data: entry.data, topics: entry.topics });
        if (decoded.eventName === "RootAnchored" || decoded.eventName === "RootAnchoredWithLedgerHead") {
          events.push({
            root: decoded.args.root,
            leafCount: decoded.args.leafCount,
            submitter: decoded.args.submitter,
          });
        }
      } catch {
        // Ignore unrelated logs from the emitter address.
      }
    }
    if (events.length === 0) throw new Error(`RootAnchored event missing from configured emitters ${emitters.join(",")}`);
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    return { events, blockTimestamp: block.timestamp };
  })();
  anchorCache.set(transactionHash, pending);
  return pending;
}

function fail(file: string, step: number | "input", error: unknown): VerificationResult {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`FAIL ${step === "input" ? "input" : `${step}/5`} ${message}`);
  console.log(`FAIL ${file}`);
  return { file, status: "FAIL", lowLead: false };
}

async function verifyFile(file: string): Promise<VerificationResult> {
  const displayFile = relative(process.cwd(), file) || file;
  console.log(`\n${displayFile}`);
  let evidence: PublishedForecastEvidence;
  try {
    evidence = JSON.parse(await readFile(file, "utf8")) as PublishedForecastEvidence;
  } catch (error) {
    return fail(displayFile, "input", error);
  }

  try {
    const batch = ledger.preparedBatches().find((item) =>
      item.leaves.some((leaf) => leaf.market_id === evidence.market_id && leaf.commitment === evidence.commitment));
    const result = await verifyPublishedEvidence(
      evidence,
      (transactionHash) => readAnchorFromChain(client, transactionHash),
      async (marketId) => {
        const market = await exchangeContext.exchange.client.getMarketOnchain(marketId);
        return { marketId, ...market };
      },
      {
        expectedSubmitter,
        riskDecision: ledger.riskDecisionsFor(evidence.market_id).at(0),
        expectedLeafCount: batch?.leaves.length,
      },
    );
    for (const step of result.steps) console.log(`${step.status} ${step.step}/5 ${step.message}`);
    // Printed beside step 5, never inside it: the verdict line below is
    // byte-identical to what it was before lead time was reported at all.
    // Only a run that reached step 5 has a chain-confirmed anchor timestamp
    // (step 3) and a chain-confirmed expiry (step 4), so only that run can
    // report a lead the file did not simply assert about itself.
    const reachedStepFive = result.steps.some((step) => step.step === 5);
    const lead = reachedStepFive ? evidenceAnchorLead(evidence, minAnchorLeadSec) : null;
    if (lead) for (const line of anchorLeadLines(lead)) console.log(line);
    console.log(`${result.status} ${displayFile}`);
    return { file: displayFile, status: result.status, lowLead: lead?.low ?? false };
  } catch (error) {
    return fail(displayFile, "input", error);
  }
}

async function evidenceFiles(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json")
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

const all = process.argv.includes("--all");
const target = process.argv.slice(2).find((argument) => argument !== "--all");
const files = all ? await evidenceFiles(resolve(target ?? "evidence")) : target ? [resolve(target)] : [];
const ledger = await AppendOnlyStore.open(resolve(process.env.RECORDER_STORE ?? "published/forecast-events.jsonl"));
if (files.length === 0) {
  console.error(all ? "FAIL no evidence files found" : "Usage: npm run verify -- evidence/<file>.json");
  process.exitCode = 1;
} else {
  const results: VerificationResult[] = [];
  for (const file of files) results.push(await verifyFile(file));
  if (all) {
    const summary = {
      total: results.length,
      pass: results.filter((result) => result.status === "PASS").length,
      not_provable: results.filter((result) => result.status === "NOT PROVABLE").length,
      fail: results.filter((result) => result.status === "FAIL").length,
      // An annotation count, listed after the three verdict counts and never
      // added to them: a LOW_LEAD record is already counted as PASS above.
      low_lead: results.filter((result) => result.lowLead).length,
      min_anchor_lead_sec: minAnchorLeadSec,
    };
    console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
  }
  if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
}
await shutdown(exchangeContext);
process.exit(process.exitCode ?? 0);
