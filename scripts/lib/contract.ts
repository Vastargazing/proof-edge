import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import solc from "solc";

export interface CompiledContract {
  abi: readonly unknown[];
  bytecode: `0x${string}`;
}

async function compileContract(fileName: string, contractName: string): Promise<CompiledContract> {
  const file = resolve(`contracts/${fileName}`);
  const source = await readFile(file, "utf8");
  const input = {
    language: "Solidity",
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 10_000 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<string, Record<string, { abi: readonly unknown[]; evm: { bytecode: { object: string } } }>>;
  };
  const errors = output.errors?.filter((item) => item.severity === "error") ?? [];
  if (errors.length > 0) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
  const contract = output.contracts?.[fileName]?.[contractName];
  if (!contract?.evm.bytecode.object) throw new Error(`solc did not produce ${contractName} bytecode`);
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

export const compileRegistry = (): Promise<CompiledContract> =>
  compileContract("ForecastRootRegistry.sol", "ForecastRootRegistry");

export const compileEmitter = (): Promise<CompiledContract> =>
  compileContract("ForecastRootEmitter.sol", "ForecastRootEmitter");
