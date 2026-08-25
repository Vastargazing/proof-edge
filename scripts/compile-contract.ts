import { mkdir, writeFile } from "node:fs/promises";
import { compileRegistry } from "./lib/contract.js";

const contract = await compileRegistry();
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/ForecastRootRegistry.json",
  `${JSON.stringify(contract, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(JSON.stringify({ bytecodeBytes: (contract.bytecode.length - 2) / 2, abiItems: contract.abi.length }));
