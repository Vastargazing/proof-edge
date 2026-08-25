import { resolve } from "node:path";
import { createPublicClient, decodeEventLog, defineChain, http } from "viem";
import { forecastRootEmitterAbi } from "../src/emitter.js";
import { AppendOnlyStore } from "../src/store.js";

const file = process.env.RECORDER_STORE ?? resolve("data/forecast-events.jsonl");
const rpcUrl = process.env.RPC_URL ?? "https://api.infra.testnet.somnia.network";
const emitter = (process.env.EMITTER_ADDRESS ?? "0x3020c7ea249b6be98d0e9acf911eaeeb766ace4f").toLowerCase();
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
    const matching = receipt.logs.some((entry) => {
      if (entry.address.toLowerCase() !== emitter) return false;
      try {
        const decoded = decodeEventLog({ abi: forecastRootEmitterAbi, data: entry.data, topics: entry.topics });
        return decoded.eventName === "RootAnchored"
          && decoded.args.root === anchor.root
          && decoded.args.leafCount === BigInt(prepared.leaves.length);
      } catch {
        return false;
      }
    });
    if (!matching) throw new Error("matching RootAnchored event missing");
    verified++;
  } catch (error) {
    failures.push(`${anchor.transaction_hash}: ${(error as Error).message}`);
  }
}

console.log(JSON.stringify({ file, emitter, verified_anchors: verified, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
