# ProofEdge demo script (2:30 target)

## 0:00–0:20 — Problem

**Visual:** Open the ProofEdge dashboard on the selected BTC window.

**Voiceover:**

> AI agents can publish confident predictions, but after a market resolves it
> is almost impossible to prove what an agent actually believed beforehand.
> ProofEdge gives any estimator a tamper-evident track record on DreamDEX Event
> Contracts.

## 0:20–0:55 — Product

**Visual:** In the § 2 ledger, compare the Agent and Market dumbbell markers,
then switch between a PASS and a VETO row. Point at the OUTCOME and BRIER A / M
columns: three of the four production windows went to the market, one (ETH/1h)
to the agent, and the closer score is underlined either way.

**Voiceover:**

> For every evaluated market we freeze the agent probability and the live
> market baseline. The risk gate may allow or veto execution, but it never
> removes the forecast from the calibration sample. That prevents selective
> reporting — the losses stay in the ledger next to the wins.

## 0:55–1:25 — Proof chain

**Visual:** Start at § 1 Resolve & score. The two large cards are the current
production `model_hash`: all evaluated windows and risk-gate passed for
execution. Point to their large N and mean agent/market probabilities. Then use
the immutable model versions table to show the old version beside the current
one. Briefly point to the quieter mixed-model historical total below the table,
then the explicit exclusion counters. Finish on the four stages in § 3 and the
production root in the docket.

**Voiceover:**

> Each canonical forecast is salted and hashed with Keccak-256. Forecasts are
> batched into a Merkle root and anchored on Somnia Shannon before expiry.
> After resolution, ProofEdge reveals the original records and automatically
> scores the agent against the market snapshot frozen at commit. The primary
> reading is always the current model version: all evaluated windows and the
> execution-eligible subset side by side. Late, voided, and unresolved windows
> stay visible as counters but never enter the score.

> The mixed total once led us to conclude that the risk gate made the model
> worse. The sealed model hashes showed that we had combined two versions and
> invalidated our own conclusion. The old and current records remain visible;
> neither was rewritten.

## 1:25–1:55 — Independent verification

**Visual:** Use § 4 Independent verification — the heading reads “Do not trust
this document. Recompute it.” Hit COPY COMMANDS on the Enclosure A card, then in
a terminal run the final two verification commands from a prepared clean clone.

```bash
npm run verify:log
npm run verify:chain
```

**Voiceover:**

> This is not a screenshot claim. From a clean clone, the local verifier checks
> every canonical hash and Merkle proof. The chain verifier independently
> matches transaction receipts, block time, emitter, root, leaf count, gas, and
> the RootAnchored event.

## 1:55–2:15 — Trading competence

**Visual:** Briefly show the lifecycle table in `SPIKE_REPORT.md`, including the
IOC fill and redemption explorer links.

**Voiceover:**

> The submission runs recorder-only by design, not because the trade path is
> missing. We separately completed the full testnet lifecycle: collateral,
> mint, IOC fill, resolution, and redeem. Execution eligibility is already
> recorded as the bridge to automated trading.

## 2:15–2:30 — Ecosystem impact

**Visual:** Return to § 1 Resolve & score: show the negative signs as rendered,
the two sample labels, and the small-sample warning.

**Voiceover:**

> ProofEdge is the trust layer above the estimator. Any DreamDEX agent can plug
> in, prove its historical edge, and earn the confidence required to attract
> capital and generate sustainable Event Contracts activity.

## Recording checklist

- Record at 1080p with browser zoom set before capture.
- Keep the final cut between 2:15 and 2:45.
- Pre-clone and install dependencies so the verification segment has no dead
  time.
- Show at least one full transaction hash and the production Merkle root.
- Do not claim a positive skill score unless the current all-evaluated or
  risk-gate-passed sample reports one. If it is negative, say so on camera.
- End on the project name, repository URL, and deployed dashboard URL.
