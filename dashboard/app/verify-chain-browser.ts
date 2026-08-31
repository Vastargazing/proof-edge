/**
 * Browser ports of the two chain readers the CLI uses in
 * `scripts/verify-evidence.ts`: `readAnchorFromChain` (viem public client) and
 * the DreamDEX SDK's `getMarketOnchain`. Only the transport changes — plain
 * JSON-RPC `fetch` instead of viem clients and the SDK. The five checks
 * themselves are NOT reimplemented here; `verifyPublishedEvidence` from `src/`
 * runs unchanged, so the browser panel and the CLI cannot drift.
 */
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import {
  forecastRootEmitterAbi,
  LEDGER_HEAD_EMITTER_ADDRESS,
  LEGACY_EMITTER_ADDRESS,
  RECORDER_SUBMITTER_ADDRESS,
} from '../../src/emitter.js';
import {
  verifyPublishedEvidence,
  type ChainAnchor,
  type ChainAnchorReader,
  type ChainMarket,
  type ChainMarketReader,
  type EvidenceVerificationResult,
  type EvidenceVerificationStatus,
} from '../../src/evidence-verifier.js';
import type { Hex32, PublishedForecastEvidence } from '../../src/types.js';

export const DEFAULT_RPC_URL = 'https://api.infra.testnet.somnia.network';
export const EXPLORER_BASE = 'https://shannon-explorer.somnia.network';
export const EXPECTED_SUBMITTER = RECORDER_SUBMITTER_ADDRESS;

/** Both production emitters; a root is accepted from either, as in the CLI. */
export const EMITTER_ADDRESSES = [LEGACY_EMITTER_ADDRESS, LEDGER_HEAD_EMITTER_ADDRESS] as const;
const emitterSet = new Set<string>(EMITTER_ADDRESSES.map((address) => address.toLowerCase()));

/**
 * DreamDEX BinaryMarketsModule on Shannon (CREATE3, identical across chains).
 * Mirrors `DEPLOYMENTS.testnet.addresses.binaryModule` in
 * `vendor/dreamdex-bot-kit/packages/ec-core/src/addresses.ts`.
 */
export const BINARY_MODULE_ADDRESS = '0x3ecC694Cef705358864a646142ac17A90E29e388';

/**
 * The two signatures `getMarketOnchain` reads. Copied verbatim from the SDK's
 * `binaryModuleReadAbi` / `binaryMarketReadAbi` so an SDK tuple change is a
 * visible diff here; `test/verify-panel.test.ts` asserts they still match the
 * installed SDK.
 */
export const BINARY_MODULE_MARKETS_SIGNATURE =
  'function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)';
export const BINARY_MARKET_SIGNATURES = [
  'function payoutNumerators() view returns (uint256[])',
  'function isResolved() view returns (bool)',
  'function isVoided() view returns (bool)',
] as const;

const binaryModuleAbi = parseAbi([BINARY_MODULE_MARKETS_SIGNATURE]);
const binaryMarketAbi = parseAbi([...BINARY_MARKET_SIGNATURES]);

/** Index of `market` and `expiry` inside the 14-field module record. */
const MARKET_ADDRESS_FIELD = 8;
const EXPIRY_FIELD = 13;

/** Minimal `fetch` surface, so tests can stub the transport without DOM types. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type JsonRpc = (method: string, params: unknown[]) => Promise<unknown>;

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export function createJsonRpc(url: string, fetchImpl?: FetchLike): JsonRpc {
  const send = fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!send) throw new Error('no fetch implementation available');
  let id = 0;
  return async (method, params) => {
    id += 1;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    } catch (error) {
      // A CORS rejection and a dead host both surface as an opaque TypeError.
      throw new Error(`${method} could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status} from ${url}`);
    const body = await response.json() as JsonRpcResponse;
    if (body.error) throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}

interface RpcReceipt {
  status: string;
  blockHash: string;
  logs: RpcLog[];
}

/**
 * Port of `readAnchorFromChain`: `eth_getTransactionReceipt` then
 * `eth_getBlockByHash`. The CLI re-reads the block by number; the receipt's own
 * `blockHash` pins the same block even if the tip moves between the two calls.
 */
export function createAnchorReader(rpc: JsonRpc): ChainAnchorReader {
  const cache = new Map<Hex32, Promise<ChainAnchor>>();
  return (transactionHash) => {
    const cached = cache.get(transactionHash);
    if (cached) return cached;
    const pending = (async (): Promise<ChainAnchor> => {
      const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]) as RpcReceipt | null;
      if (receipt === null) throw new Error(`anchor transaction ${transactionHash} not found on this RPC`);
      if (BigInt(receipt.status) !== 1n) throw new Error('anchor transaction reverted');
      const events: ChainAnchor['events'] = [];
      for (const entry of receipt.logs) {
        if (!emitterSet.has(entry.address.toLowerCase())) continue;
        try {
          const decoded = decodeEventLog({
            abi: forecastRootEmitterAbi,
            data: entry.data as Hex32,
            topics: entry.topics as [signature: Hex32, ...args: Hex32[]],
          });
          if (decoded.eventName === 'RootAnchored' || decoded.eventName === 'RootAnchoredWithLedgerHead') {
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
      if (events.length === 0) {
        throw new Error(`RootAnchored event missing from configured emitters ${EMITTER_ADDRESSES.join(',')}`);
      }
      const block = await rpc('eth_getBlockByHash', [receipt.blockHash, false]) as { timestamp: string } | null;
      if (block === null) throw new Error(`anchor block ${receipt.blockHash} not found on this RPC`);
      return { events, blockTimestamp: BigInt(block.timestamp) };
    })();
    cache.set(transactionHash, pending);
    return pending;
  };
}

const ZERO_ADDRESS = /^0x0{40}$/;

/**
 * Port of the SDK's `getMarketOnchain`, reduced to the four fields the verifier
 * consumes: the module record supplies the market contract and expiry, the
 * market contract supplies the payout vector and its resolution flags.
 */
export function createMarketReader(rpc: JsonRpc, moduleAddress = BINARY_MODULE_ADDRESS): ChainMarketReader {
  const call = async (to: string, data: Hex32): Promise<Hex32> =>
    await rpc('eth_call', [{ to, data }, 'latest']) as Hex32;
  return async (marketId): Promise<ChainMarket> => {
    const record = decodeFunctionResult({
      abi: binaryModuleAbi,
      functionName: 'markets',
      data: await call(moduleAddress, encodeFunctionData({
        abi: binaryModuleAbi,
        functionName: 'markets',
        args: [marketId],
      })),
    });
    const marketAddress = record[MARKET_ADDRESS_FIELD];
    const expiry = record[EXPIRY_FIELD];
    // Same guard and wording as the SDK: an id the module never registered.
    if (ZERO_ADDRESS.test(marketAddress)) throw new Error(`unknown marketId ${marketId} on the module`);

    const read = async <T>(
      functionName: 'payoutNumerators' | 'isResolved' | 'isVoided',
    ): Promise<T> => decodeFunctionResult({
      abi: binaryMarketAbi,
      functionName,
      data: await call(marketAddress, encodeFunctionData({ abi: binaryMarketAbi, functionName })),
    }) as T;
    const [payoutNumerators, isResolved, isVoided] = await Promise.all([
      read<readonly bigint[]>('payoutNumerators'),
      read<boolean>('isResolved'),
      read<boolean>('isVoided'),
    ]);

    // Settlement v3 stores a payout VECTOR. The winner is its argmax; an
    // unresolved market has an empty vector and a void is uniform, so both are
    // disambiguated by isResolved / isVoided downstream, never by this index.
    let winningOutcome = 0;
    for (let i = 1; i < payoutNumerators.length; i++) {
      if ((payoutNumerators[i] ?? 0n) > (payoutNumerators[winningOutcome] ?? 0n)) winningOutcome = i;
    }
    return { marketId, expiry, winningOutcome, isResolved, isVoided };
  };
}

/** Display status for a step the run never reached. The verdict never takes it. */
export type PanelStepStatus = EvidenceVerificationStatus | 'NOT RUN';

export interface PanelStep {
  step: 1 | 2 | 3 | 4 | 5;
  status: PanelStepStatus;
  /** Byte-for-byte the line the CLI prints, e.g. `PASS 1/5 canonical preimage -> 0x…`. */
  line: string;
  /** One line of plain prose: what passing this step establishes. */
  explanation: string;
}

export interface PanelResult {
  /** Exactly the CLI's three verdicts. Nothing else is ever returned. */
  verdict: EvidenceVerificationStatus;
  steps: PanelStep[];
  anchorTx: Hex32 | null;
  explorerUrl: string | null;
  /** Set when the file never reached step 1, mirroring the CLI's `FAIL input`. */
  inputError: string | null;
}

const EXPLANATIONS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'The disclosed fields re-serialize to the frozen canonical JSON and hash to the published commitment.',
  2: 'The published siblings walk that commitment up to the published Merkle root.',
  3: 'That exact root, leaf count and block time come back from the recorder wallet inside the anchor transaction.',
  4: 'Expiry and outcome are re-read from the DreamDEX market on chain, not from this file.',
  5: 'The anchor block timestamp is strictly before the on-chain expiry, so the forecast was sealed before the answer existed.',
};

const NOT_RUN_REASON = 'Not reached: an earlier step already decided the verdict.';

export function explorerTransactionUrl(transactionHash: string): string {
  return `${EXPLORER_BASE}/tx/${transactionHash}`;
}

/** Renders a verifier result as the five CLI lines, padding the steps it never reached. */
export function describeVerification(
  evidence: PublishedForecastEvidence | null,
  result: EvidenceVerificationResult,
): PanelResult {
  const steps: PanelStep[] = [];
  for (const step of [1, 2, 3, 4, 5] as const) {
    const reached = result.steps.find((item) => item.step === step);
    steps.push(reached
      ? {
        step,
        status: reached.status,
        line: `${reached.status} ${step}/5 ${reached.message}`,
        explanation: EXPLANATIONS[step],
      }
      : { step, status: 'NOT RUN', line: `— ${step}/5`, explanation: NOT_RUN_REASON });
  }
  const anchorTx = evidence?.anchor_tx ?? null;
  return {
    verdict: result.status,
    steps,
    anchorTx,
    explorerUrl: anchorTx === null ? null : explorerTransactionUrl(anchorTx),
    inputError: null,
  };
}

/** The CLI's `FAIL input <message>` path: an unparsable or unusable file. */
export function inputFailure(message: string): PanelResult {
  return {
    verdict: 'FAIL',
    steps: ([1, 2, 3, 4, 5] as const).map((step) => ({
      step,
      status: 'NOT RUN' as const,
      line: `— ${step}/5`,
      explanation: NOT_RUN_REASON,
    })),
    anchorTx: null,
    explorerUrl: null,
    inputError: message,
  };
}

export function parseEvidenceJson(text: string): PublishedForecastEvidence {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evidence must be a JSON object');
  }
  return value as PublishedForecastEvidence;
}

export interface VerifyOptions {
  rpcUrl?: string;
  fetchImpl?: FetchLike;
  /** Injected by tests; production builds construct readers from the RPC URL. */
  readAnchor?: ChainAnchorReader;
  readMarket?: ChainMarketReader;
  expectedSubmitter?: string;
}

/**
 * One sealed forecast, five checks, one verdict. Every failure mode — bad JSON,
 * a dead RPC, a tampered digit — resolves to a PanelResult rather than throwing,
 * because the panel has to render something for each of them.
 */
export async function verifyEvidenceInBrowser(
  evidence: PublishedForecastEvidence,
  options: VerifyOptions = {},
): Promise<PanelResult> {
  let readAnchor = options.readAnchor;
  let readMarket = options.readMarket;
  if (!readAnchor || !readMarket) {
    try {
      const rpc = createJsonRpc(options.rpcUrl?.trim() || DEFAULT_RPC_URL, options.fetchImpl);
      readAnchor ??= createAnchorReader(rpc);
      readMarket ??= createMarketReader(rpc);
    } catch (error) {
      return inputFailure(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const result = await verifyPublishedEvidence(evidence, readAnchor, readMarket, {
      // A static page has no ledger, so legacy files missing `risk_decision` or
      // `leaf_count` fail at step 1 instead of silently borrowing context.
      expectedSubmitter: options.expectedSubmitter ?? EXPECTED_SUBMITTER,
    });
    return describeVerification(evidence, result);
  } catch (error) {
    return inputFailure(error instanceof Error ? error.message : String(error));
  }
}

/** One entry of `dashboard/public/evidence/index.json`, written by the mirror step. */
export interface MirroredEvidenceEntry {
  file: string;
  market_id: string;
  symbol: string;
  interval_sec: number;
  observed_at_ns: string;
  expiry_ns: string;
  outcome: string;
  anchored_late: boolean;
  anchor_tx: string;
  root: string;
  leaf_index: number;
  leaf_count: number | null;
  flagship: boolean;
}

export interface MirroredEvidenceIndex {
  generated_from: string;
  flagship: string;
  entries: MirroredEvidenceEntry[];
}
