# ProofEdge demo script (2:30 target)

## 0:00–0:20 — Problem

**Visual:** Open the ProofEdge dashboard on the selected BTC window.

**Voiceover:**

> AI agents can publish confident predictions, but after a market resolves it
> is almost impossible to prove what an agent actually believed beforehand.
> ProofEdge gives any estimator a tamper-evident track record on DreamDEX Event
> Contracts.

## 0:20–0:55 — Product

**Visual:** Compare Agent and Market probabilities, then switch between a PASS
and BLOCK row.

**Voiceover:**

> For every evaluated market we freeze the agent probability and the live
> market baseline. The risk gate may allow or veto execution, but it never
> removes the forecast from the calibration sample. That prevents selective
> reporting.

## 0:55–1:25 — Proof chain

**Visual:** Show the four proof stages, click the Shannon explorer link, and
point to the emitted production root.

**Voiceover:**

> Each canonical forecast is salted and hashed with Keccak-256. Forecasts are
> batched into a Merkle root and anchored on Somnia Shannon before expiry.
> After resolution, ProofEdge reveals the original records and scores the agent
> against the market using Brier Skill Score.

## 1:25–1:55 — Independent verification

**Visual:** Use the dashboard's “Verify it yourself” section. In a terminal,
run the final two verification commands from a prepared clean clone.

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

**Visual:** Return to the dashboard root and score summary.

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
- Do not claim a positive skill score unless the current production snapshot
  reports one.
- End on the project name, repository URL, and deployed dashboard URL.
