import { resolve } from "node:path";
import { createPublicClient, decodeEventLog, defineChain, http } from "viem";
import { verifyEmittedRootAnchor } from "../src/chain-verifier.js";
import {
  forecastRootEmitterAbi,
  LEDGER_HEAD_EMITTER_ADDRESS,
  LEGACY_EMITTER_ADDRESS,
} from "../src/emitter.js";
import { AppendOnlyStore } from "../src/store.js";

const file = process.env.RECORDER_STORE ?? resolve("published/forecast-events.jsonl");
const rpcUrl = process.env.RPC_URL ?? "https://api.infra.testnet.somnia.network";
const emitters = (process.env.EMITTER_ADDRESSES
  ?? process.env.EMITTER_ADDRESS
  ?? `${LEGACY_EMITTER_ADDRESS},${LEDGER_HEAD_EMITTER_ADDRESS}`)
  .split(",").map((address) => address.trim().toLowerCase()).filter(Boolean);
const emitterSet = new Set(emitters);
const chain = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const store = await AppendOnlyStore.open(file);
const failures: string[] = [];
let verified = 0;
let onTime = 0;
let anchoredLate = 0;

if (store.anchoredBatches().length === 0) failures.push("ledger contains no anchored batches");

for (const anchor of store.anchoredBatches()) {
  try {
    const receipt = await client.getTransactionReceipt({ hash: anchor.transaction_hash });
    if (receipt.status !== "success") throw new Error("transaction reverted");
    if (receipt.blockNumber.toString() !== anchor.block_number) throw new Error("block number mismatch");
    if (receipt.gasUsed.toString() !== anchor.gas_used) throw new Error("gas used mismatch");
    if (receipt.effectiveGasPrice.toString() !== anchor.effective_gas_price) throw new Error("gas price mismatch");
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.timestamp.toString() !== anchor.block_timestamp) throw new Error("block timestamp mismatch");
    const prepared = store.preparedBatches().find((item) => item.batch_id === anchor.batch_id);
    if (!prepared) throw new Error("prepared batch missing");
    let matching = false;
    const eventFailures: string[] = [];
    for (const entry of receipt.logs) {
      if (!emitterSet.has(entry.address.toLowerCase())) continue;
      try {
        const decoded = decodeEventLog({ abi: forecastRootEmitterAbi, data: entry.data, topics: entry.topics });
        if (decoded.eventName === "RootAnchored") {
          verifyEmittedRootAnchor(prepared, {
            root: decoded.args.root,
            leafCount: decoded.args.leafCount,
          });
          matching = true;
          break;
        }
        if (decoded.eventName === "RootAnchoredWithLedgerHead") {
          verifyEmittedRootAnchor(prepared, {
            root: decoded.args.root,
            leafCount: decoded.args.leafCount,
            ledgerHead: decoded.args.ledgerHead,
          });
          matching = true;
          break;
        }
      } catch (error) {
        eventFailures.push((error as Error).message);
      }
    }
    if (!matching) {
      throw new Error(eventFailures.find((message) => message.includes("ledger head"))
        ?? "matching RootAnchored event missing");
    }
    verified++;
    if (store.batchAnchorStatus(anchor.batch_id) === "on_time") onTime++;
    else anchoredLate++;
  } catch (error) {
    failures.push(`${anchor.transaction_hash}: ${(error as Error).message}`);
  }
}

console.log(JSON.stringify({
  file,
  emitters,
  verified_anchors: verified,
  on_time_anchors: onTime,
  anchored_late_batches: anchoredLate,
  failures,
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
