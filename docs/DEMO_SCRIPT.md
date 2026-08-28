# ProofEdge demo script — 2:30

This cut matches `dashboard/app/forecast-data.json` introduced by snapshot
commit `77a5f5a44b45f9270de1b3d78b44e9e6db4e0d09`. The recorder publishes new
snapshots hourly. If that file changes before capture, refresh every number in
the table below and rehearse against the rendered page again.

## Capture facts

| Item | Value in this cut |
| --- | --- |
| Forecasts | 252 |
| On-chain roots | 113; all 113 on time |
| Provable forecasts | 238 of 252 |
| Pending resolution | 8 |
| Completeness | 0 failures; 0 roots pending after watermark |
| Retained ledger orphan | 1 |
| Sealed model versions | 7 |
| Current model, all evaluated | skill `−0.486`, `N = 27` |
| Current model, risk-gate PASS | skill `−0.312`, `N = 3` |
| Mixed-model history, all evaluated | skill `−0.343`, `N = 244` |
| Root shown in § 4 | `0xcbe1724684cc25a1c8403839c2d15a69c70ccef43869483d75bd70298643d353` |
| Anchor transaction | `0xc90e122119af902f64dfcc82f23245c2aa33a97f48d3b0212cc484c8d5cf9116` |

The source for these values is
`dashboard/app/forecast-data.json:2-380`. The labels and empty-value behavior
come from `dashboard/app/page.tsx:112-141,212-270,298-366`.

Use three dashboard positions only:

1. § 2 selected window;
2. § 1 score cards and model table;
3. § 4 independent verification.

The explorer and `docs/SPIKE_REPORT.md` are brief cutaways, not extra dashboard
scroll positions.

## 0:00–0:20 — The claim exists before the answer

**Visual:** Open anchor transaction
`0xc90e122119af902f64dfcc82f23245c2aa33a97f48d3b0212cc484c8d5cf9116`
in the Shannon explorer. Show the full transaction hash, emitted root and block
time. Cut to the selected BTC / 15M row in § 2; its outcome is still
`PENDING`.

**Voiceover:**

> This Merkle root is already on Shannon, while the selected BTC window is
> still unresolved. It commits the probability, market baseline, model hash and
> evidence digest. If we change those bytes after the answer, the verifier
> fails.

## 0:20–0:55 — Record first, gate second

**Visual:** Stay in § 2. Point to the compact dumbbell and the Agent/Market
columns: `91.86%` against `65.05%`. Open the selected-window exhibit and point,
in order, to `DIVERGENCE TOWARD YES`, `EDGE AT COMMIT 26.81 pp`,
`TRADE VETOED`, and the risk ruling. Finish on the pending outcome and Brier
“—” values.

**Voiceover:**

> The estimator put YES at 91.86 percent. The market midpoint was 65.05. That is
> a 26.81-point divergence toward YES, above the ten-point ceiling, so execution
> was vetoed. The forecast was not discarded. It stayed in the ledger before
> the outcome existed, and the Brier cells remain blank until resolution.

The detail label is `DIVERGENCE TOWARD`. Do not say or point to
`COMMITTED SIDE`; that label no longer exists
(`dashboard/app/page.tsx:324-331`).

## 0:55–1:15 — Show the loss

**Visual:** Move once to the two current-production cards in § 1. Hold both in
frame with the `N < 100 · DIAGNOSTIC ONLY` warnings.

**Voiceover:**

> The current model is not beating the market in this snapshot. Across all 27
> evaluated windows, skill is minus 0.486. The three risk-gate PASS windows are
> minus 0.312. Both samples are below 100, so the page labels them diagnostic,
> not performance.

Do not improvise a positive interpretation. The all-evaluated 95% interval
crosses zero, and the PASS sample has only three observations
(`dashboard/app/forecast-data.json:300-335` in the source ledger-derived
snapshot; use the rendered cards if a later snapshot moves the JSON offsets).

## 1:15–1:30 — Keep model versions separate

**Visual:** Within § 1, reveal `Immutable model versions`, with
`7 VERSIONS · CURRENT FIRST`, then the muted `Mixed-model historical total`.
Point to the `SECONDARY` label and the mixed all-evaluated value
`−0.343 · N = 244`.

**Voiceover:**

> Seven model hashes are sealed in this history. We once read their combined
> average as if one model had produced it. The table keeps every version
> separate now. The minus 0.343 mixed total remains visible, but only as
> secondary context.

The confidence-interval cell renders “—” when `N = 1`; it does not fabricate a
bootstrap range from one observation (`dashboard/app/page.tsx:236-250`). Do not
point to or narrate an interval if a refreshed snapshot introduces an
`N = 1` row.

## 1:30–2:00 — Recompute it

**Visual:** Make the third and final dashboard move to § 4. Hold the root and
anchor transaction beside “Do not trust this document. Recompute it.” Click
`COPY COMMANDS`, then show the prepared clean clone running:

```bash
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all
```

End the terminal cut on the dashboard's expected line:
`238 / 252 PROVABLE · 113 / 113 ON-TIME ROOTS · 0 FAILURES · 0 PENDING AFTER WATERMARK`.

**Voiceover:**

> A clean clone rebuilds the canonical commitments and Merkle proofs. It matches
> receipts, block times, emitters, roots, leaf counts and the forward ledger
> head, then reads market expiry and outcome from Shannon. Completeness scans
> every root from the declared production submitter and block range. In this
> snapshot it finds 113 disclosed roots and zero missing ones.

Do not call this an uptime proof. The declared emitter, submitter and block
range remain part of the trust boundary (`THREAT_MODEL.md:224-260`).

## 2:00–2:15 — The trade path was tested separately

**Visual:** Cut to the lifecycle table in `docs/SPIKE_REPORT.md`. Keep the IOC
fill and redeem transaction links visible: the order filled one YES at
`0.419 tUSDC`; after NO won, one NO redeemed for approximately `1 tUSDC`.

**Voiceover:**

> Recorder-only is a scope decision, not a missing exchange path. In a separate
> Shannon run we completed collateral, approval, mint, IOC fill, resolution and
> redeem. This build records whether execution was eligible, but it sends no
> order.

The transaction evidence is at `docs/SPIKE_REPORT.md:29-77`.

## 2:15–2:30 — End on the result we cannot edit

**Visual:** Return to the current-model cards in § 1. Keep the two negative
skills, both sample sizes and the small-sample warnings in frame. End on the
repository URL and project name.

**Voiceover:**

> We recorded 252 forecasts and anchored 113 roots. The current model's measured
> skill is negative. ProofEdge does not turn that into a win; it proves that we
> committed the inputs before resolution and did not rewrite the loss afterward.

## Recording checklist

- Final recording pass — 6 September: treat snapshot `77a5f5a` as a rehearsal
  reference only. New 15-minute windows keep accumulating. After the final
  pull, update the counts, scores, selected-row values and expected verifier
  line to match the rendered dashboard; keep the timing and narrative beats.
- Pin one Git commit for the dashboard, script and prepared verification clone.
- Re-read `dashboard/app/forecast-data.json` after the final pull. If any value
  differs from “Capture facts,” update the spoken line and expected terminal
  line before recording.
- Confirm § 2 still has the BTC / 15M pending VETO row before using the
  91.86/65.05/26.81 narration. If it changed, narrate the rendered row instead.
- Use `DIVERGENCE TOWARD`; never `COMMITTED SIDE`.
- Treat a confidence interval at `N = 1` as “—”.
- Pre-clone and install dependencies; do not spend demo time on `npm ci`.
- Show one full transaction hash and one full Merkle root.
- Keep the cut between 2:15 and 2:45.
- Do not claim positive skill unless the rendered current-model card is positive
  and its sample/interval support that statement. The snapshot used here does
  not.
