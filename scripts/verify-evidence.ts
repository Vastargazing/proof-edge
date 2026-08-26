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
import { forecastRootEmitterAbi } from "../src/emitter.js";
import type { Hex32, PublishedForecastEvidence } from "../src/types.js";

const DEFAULT_RPC = "https://api.infra.testnet.somnia.network";
const DEFAULT_EMITTER = "0x3020c7ea249b6be98d0e9acf911eaeeb766ace4f";
const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC;
const emitter = getAddress(process.env.EMITTER_ADDRESS ?? DEFAULT_EMITTER);
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
}

const anchorCache = new Map<Hex32, Promise<{ roots: Hex32[]; blockTimestamp: bigint }>>();

async function readAnchorFromChain(
  publicClient: PublicClient,
  transactionHash: Hex32,
): Promise<{ roots: Hex32[]; blockTimestamp: bigint }> {
  const cached = anchorCache.get(transactionHash);
  if (cached) return cached;
  const pending = (async () => {
    const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("anchor transaction reverted");
    const roots: Hex32[] = [];
    for (const entry of receipt.logs) {
      if (entry.address.toLowerCase() !== emitter.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: forecastRootEmitterAbi, data: entry.data, topics: entry.topics });
        if (decoded.eventName === "RootAnchored" || decoded.eventName === "RootAnchoredWithLedgerHead") {
          roots.push(decoded.args.root);
        }
      } catch {
        // Ignore unrelated logs from the emitter address.
      }
    }
    if (roots.length === 0) throw new Error(`RootAnchored event missing from emitter ${emitter}`);
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    return { roots, blockTimestamp: block.timestamp };
  })();
  anchorCache.set(transactionHash, pending);
  return pending;
}

function fail(file: string, step: number | "input", error: unknown): VerificationResult {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`FAIL ${step === "input" ? "input" : `${step}/5`} ${message}`);
  console.log(`FAIL ${file}`);
  return { file, status: "FAIL" };
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
    const result = await verifyPublishedEvidence(
      evidence,
      (transactionHash) => readAnchorFromChain(client, transactionHash),
      async (marketId) => {
        const market = await exchangeContext.exchange.client.getMarketOnchain(marketId);
        return { marketId, ...market };
      },
    );
    for (const step of result.steps) console.log(`${step.status} ${step.step}/5 ${step.message}`);
    console.log(`${result.status} ${displayFile}`);
    return { file: displayFile, status: result.status };
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
    };
    console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
  }
  if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
}
await shutdown(exchangeContext);
