import { completenessFailures, type CompletenessReport } from "../src/completeness.js";
import type { Hex32 } from "../src/types.js";

export interface AcceptedDuplicateAnchor {
  root: Hex32;
  transactions: Hex32[];
  ledger_transaction: Hex32;
  reason: string;
}

export const DUPLICATE_ANCHOR_REASON =
  "root anchored more than once by the declared submitter, disclosed once in the ledger, "
  + "leaf counts agree, and the ledger's own anchor is one of these transactions";

/**
 * A root anchored twice by our own submitter is a resend, not an omission. It
 * happens when the recorder loses the receipt of an anchoring transaction that
 * did land — a crash between send and receipt is enough — and the recovery
 * path submits the same fsynced batch again, producing an identical root under
 * the next nonce.
 *
 * `src/completeness.ts` reports every duplicate as a failure and cannot be
 * changed during the collection window without rotating `model_hash`, so the
 * publication policy is decided here instead: a duplicate is accepted only
 * when the root is disclosed, its leaf counts agree with the ledger, and the
 * ledger's own `batch_anchored` names one of the duplicate transactions.
 * A duplicate of an undisclosed root, a disagreeing leaf count, or a ledger
 * anchor pointing somewhere else is still a blocking failure.
 */
export function acceptedDuplicateAnchors(
  report: Pick<CompletenessReport, "duplicateRootAnchors" | "undisclosed" | "leafCountMismatches">,
  anchoredTransactionByRoot: ReadonlyMap<Hex32, Hex32>,
): AcceptedDuplicateAnchor[] {
  const undisclosedRoots = new Set(report.undisclosed.map((anchor) => anchor.root));
  const mismatchedRoots = new Set(report.leafCountMismatches.map((item) => item.root));
  return report.duplicateRootAnchors.flatMap((item) => {
    if (undisclosedRoots.has(item.root) || mismatchedRoots.has(item.root)) return [];
    const ledgerTransaction = anchoredTransactionByRoot.get(item.root);
    if (ledgerTransaction === undefined || !item.transactions.includes(ledgerTransaction)) return [];
    return [{
      root: item.root,
      transactions: [...item.transactions],
      ledger_transaction: ledgerTransaction,
      reason: DUPLICATE_ANCHOR_REASON,
    }];
  });
}

/** Failures that still stop a publication, formatted by `src/completeness.ts`. */
export function blockingCompletenessFailures(
  report: CompletenessReport,
  accepted: readonly AcceptedDuplicateAnchor[],
): string[] {
  const acceptedRoots = new Set(accepted.map((item) => item.root));
  return completenessFailures({
    ...report,
    duplicateRootAnchors: report.duplicateRootAnchors.filter((item) => !acceptedRoots.has(item.root)),
  });
}
