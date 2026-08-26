# ProofEdge demo script (2:30 target)

## 0:00–0:20 — Problem

**Visual:** For the first five seconds, open the production transaction in the
Somnia explorer and point to the Merkle root and block time. Then cut to the
ProofEdge dashboard on the selected BTC window.

**Voiceover:**

> AI agents can publish confident predictions, but after a market resolves it
> is almost impossible to prove what an agent actually believed beforehand.
> ProofEdge gives any estimator a tamper-evident track record on DreamDEX Event
> Contracts. Every sealed forecast shown here can be re-checked from a clean
> clone.

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

## 0:55–1:10 — Resolve and score

**Visual:** Hold on the two large current-version cards in § 1. This is the
first of three visual positions; do not scroll during the voiceover.

**Voiceover:**

> After resolution, we publish the record and score the agent against the
> market price frozen at commit time. Late, voided, or unresolved windows stay
> visible as counters, but they never enter the score.

## 1:10–1:25 — What versioning caught

**Visual:** Move once to the immutable model versions table and the muted mixed
historical total. Point to the mixed number; keep both versions in view.

**Voiceover:**

> This number here once told us our own risk gate was making the model worse.
> It wasn't — we had mixed two model versions in one average. The sealed hashes
> showed it. Both versions are still here, and neither was rewritten.

## 1:25–1:55 — Proof and independent verification

**Visual:** Make the third and final move to § 4, where the production root sits
beside “Do not trust this document. Recompute it.” Hit COPY COMMANDS, then run
the final two verification commands from a prepared clean clone.

```bash
npm run verify:log
npm run verify:chain
```

**Voiceover:**

> Every forecast gets a random salt and a hash. The hashes form a Merkle root
> that lands on-chain before expiry, while the outcome is still unknown. So the
> prediction is locked before it can be scored.
>
> This is not a screenshot claim. From a clean clone, the local verifier checks
> every canonical hash and Merkle proof. The chain verifier independently
> matches the transaction receipt, block time, emitter, root, leaf count, and
> RootAnchored event.

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
