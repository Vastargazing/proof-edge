'use client';

import { useMemo, useState } from 'react';
import snapshot from './forecast-data.json';

type Forecast = {
  id: string;
  idShort: string;
  asset: 'BTC' | 'ETH';
  interval: string;
  pAgent: number;
  pMarket: number;
  edge: number;
  allowed: boolean;
  side: 'YES' | 'NO';
  reason: string;
  evidence: string;
  outcome: string | null;
  brierAgent: number | null;
  brierMarket: number | null;
};

type ScoreSample = {
  n: number;
  mean_p_agent: number | null;
  mean_p_market: number | null;
  mean_probability_gap: number | null;
  brier_agent: number | null;
  brier_market: number | null;
  skill_score: number | null;
  skill_score_ci_95: {
    low: number;
    high: number;
    resamples: number;
  } | null;
};

const repository = 'https://github.com/Vastargazing/proof-edge';
const verificationCommands = `git clone --recurse-submodules ${repository}.git
cd proof-edge
npm ci
npm run check
npm run verify:log
npm run verify:chain
npm run verify:completeness
npm run verify:all`;

function short(value: string, start = 8, end = 6) { return `${value.slice(0, start)}…${value.slice(-end)}`; }
function interval(sec: number) {
  if (sec % 86400 === 0) return `${sec / 86400}D`;
  if (sec % 3600 === 0) return `${sec / 3600}H`;
  return `${Math.round(sec / 60)}M`;
}
function pct(value: number) { return (value * 100).toFixed(2); }
function signed(value: number) { return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(3)}`; }

const forecasts: Forecast[] = snapshot.production.forecasts.map((item) => ({
  id: item.id,
  idShort: short(item.id, 6, 4),
  asset: item.asset as Forecast['asset'],
  interval: interval(item.interval_sec),
  pAgent: item.p_agent * 100,
  pMarket: item.p_market * 100,
  edge: item.edge * 100,
  allowed: item.allowed,
  side: item.side as Forecast['side'],
  reason: item.risk_reason,
  evidence: item.evidence_digest,
  outcome: item.outcome ?? null,
  brierAgent: item.brier_agent ?? null,
  brierMarket: item.brier_market ?? null,
}));

const root = snapshot.production.root;
const tx = snapshot.production.transaction_hash;
const explorer = `https://shannon-explorer.somnia.network/tx/${tx}`;
const allEvaluated = snapshot.resolve_score.all_evaluated_windows;
const riskPassed = snapshot.resolve_score.risk_gate_passed;
const modelBreakdown = snapshot.resolve_score.by_model_hash;
const currentModel = modelBreakdown.find((model) => model.model_hash === snapshot.production.model_hash) ?? modelBreakdown.at(-1)!;
const orderedModelBreakdown = [currentModel, ...modelBreakdown.filter((model) => model.model_hash !== currentModel.model_hash)];
const exclusions = snapshot.resolve_score.exclusions;
const scored = allEvaluated.n > 0;
const completenessFailures = 'completeness_failures' in snapshot.totals
  ? Number(snapshot.totals.completeness_failures)
  : 0;
const completenessPendingRoots = 'completeness_pending_roots' in snapshot.totals
  ? Number(snapshot.totals.completeness_pending_roots)
  : 0;

function Dumbbell({ agent, market, compact }: { agent: number; market: number; compact?: boolean }) {
  const lo = Math.min(agent, market);
  const hi = Math.max(agent, market);
  return (
    <span className={compact ? 'scale compact' : 'scale'} aria-label={`Agent ${agent.toFixed(2)}%, market ${market.toFixed(2)}%`}>
      {!compact && <span className="scale-ticks" aria-hidden>{[0, 25, 50, 75, 100].map((t) => <i key={t} style={{ left: `${t}%` }}><em>{t}</em></i>)}</span>}
      <span className="scale-track" aria-hidden>
        <i className="scale-span" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        <i className="scale-dot market" style={{ left: `${market}%` }} title={`Market ${market.toFixed(2)}%`} />
        <i className="scale-dot agent" style={{ left: `${agent}%` }} title={`Agent ${agent.toFixed(2)}%`} />
        {!compact && <i className={`scale-flag agent-flag ${agent > market ? 'right' : 'left'}`} style={{ left: `${agent}%` }}>AGENT {agent.toFixed(2)}</i>}
        {!compact && <i className={`scale-flag market-flag ${agent > market ? 'left' : 'right'}`} style={{ left: `${market}%` }}>MARKET {market.toFixed(2)}</i>}
      </span>
    </span>
  );
}

function ScoreCard({ title, description, sample }: { title: string; description: string; sample: ScoreSample }) {
  const ci = sample.skill_score_ci_95;
  return (
    <article className="score-card">
      <div className="score-card-head">
        <div><h3>{title}</h3><p>{description}</p></div>
        <em>CURRENT PRODUCTION</em>
      </div>
      <div className="score-metrics">
        <div className="score-metric primary">
          <span>SKILL SCORE</span>
          <p><b>{sample.skill_score === null ? '—' : signed(sample.skill_score)}</b><strong>N = {sample.n}</strong></p>
          <small>{ci === null ? '95% CI undefined: zero-loss baseline' : `95% CI [${signed(ci.low)}, ${signed(ci.high)}]`}</small>
        </div>
        <div className="score-metric">
          <span>BRIER · AGENT</span>
          <p><b>{sample.brier_agent?.toFixed(3) ?? '—'}</b><strong>N = {sample.n}</strong></p>
          <small>LOWER IS BETTER</small>
        </div>
        <div className="score-metric">
          <span>BRIER · MARKET AT COMMIT</span>
          <p><b>{sample.brier_market?.toFixed(3) ?? '—'}</b><strong>N = {sample.n}</strong></p>
          <small>FROZEN, NEVER REFRESHED</small>
        </div>
      </div>
      <div className="probability-means" aria-label="Mean sealed probabilities">
        <div><span>MEAN p_AGENT</span><p><b>{sample.mean_p_agent?.toFixed(3) ?? '—'}</b><strong>N = {sample.n}</strong></p></div>
        <div><span>MEAN p_MARKET</span><p><b>{sample.mean_p_market?.toFixed(3) ?? '—'}</b><strong>N = {sample.n}</strong></p></div>
        <div><span>AGENT − MARKET</span><p><b>{sample.mean_probability_gap === null ? '—' : signed(sample.mean_probability_gap)}</b><strong>N = {sample.n}</strong></p></div>
      </div>
      {sample.n < 100 && <p className="sample-warning">N &lt; 100 · DIAGNOSTIC ONLY · DO NOT READ AS PERFORMANCE</p>}
    </article>
  );
}

export default function Home() {
  const [selectedId, setSelectedId] = useState(forecasts[0].id);
  const [copied, setCopied] = useState(false);
  const selected = useMemo(() => forecasts.find((item) => item.id === selectedId) ?? forecasts[0], [selectedId]);

  async function copyVerification() {
    await navigator.clipboard.writeText(verificationCommands);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="sheet">
      <header className="letterhead">
        <a className="brand" href="#top" aria-label="Proof Edge home">
          <svg viewBox="0 0 40 40" aria-hidden><circle cx="20" cy="20" r="18" /><text x="20" y="25">P·E</text></svg>
          <span>PROOF·EDGE</span>
        </a>
        <p className="letterhead-title">ATTESTATION OF FORECAST INTEGRITY · Nº 0002</p>
        <p className="letterhead-net"><span className="pulse" aria-hidden /> SOMNIA SHANNON · TESTNET 50312</p>
      </header>

      <section className="masthead" id="top">
        <div>
          <p className="eyebrow">VERIFIABLE FORECAST RECORDER / V1</p>
          <h1>Forecast preimages that cannot change after anchoring.</h1>
          <p className="abstract">
            Bring any estimator. Proof·Edge freezes its probability and a contemporaneous
            market snapshot, seals both under a salted Keccak-256 commitment, and anchors
            the batch before on-chain expiry. There is no minimum lead-time guarantee.
            Pending and resolved records are published together, so losses remain beside wins.
          </p>
        </div>
        <figure className="stamp-figure" aria-label={`${snapshot.totals.provable_forecasts} forecasts provable, ${snapshot.totals.on_time_anchors} roots anchored on time`}>
          <svg className="stamp" viewBox="0 0 200 200" aria-hidden>
            <defs><path id="stamp-arc" d="M100,100 m-72,0 a72,72 0 1,1 144,0 a72,72 0 1,1 -144,0" /></defs>
            <circle cx="100" cy="100" r="95" className="ring-outer" />
            <circle cx="100" cy="100" r="88" className="ring-outer thin" />
            <circle cx="100" cy="100" r="56" className="ring-inner" />
            <text className="arc-text"><textPath href="#stamp-arc">ANCHORED ON SOMNIA SHANNON · KECCAK-256 SEALED · MERKLE PROVEN ·</textPath></text>
            <text x="100" y="96" textAnchor="middle" className="stamp-count">{snapshot.totals.provable_forecasts}</text>
            <text x="100" y="116" textAnchor="middle" className="stamp-sub">RESOLVED PROOFS</text>
            <text x="100" y="130" textAnchor="middle" className="stamp-sub">ON-TIME ROOTS ×{snapshot.totals.on_time_anchors}</text>
          </svg>
        </figure>
      </section>

      <section className="docket" aria-label="Document references">
        <div className="docket-row"><span>Production root</span><i /><code>{root}</code></div>
        <div className="docket-row"><span>Anchor transaction</span><i /><a href={explorer} target="_blank" rel="noreferrer"><code>{short(tx, 10, 8)}</code> ↗</a></div>
        <div className="docket-row"><span>Model hash</span><i /><code>{short(snapshot.production.model_hash, 10, 8)}</code></div>
        <div className="docket-row"><span>Estimator</span><i /><code>dreamdex-ec-oracle-follow-strike-adapter</code></div>
        <div className="docket-row"><span>Ledger</span><i /><code>{snapshot.generated_from}</code></div>
        <div className={`docket-row late ${snapshot.totals.anchored_late_forecasts > 0 ? 'alert' : ''}`}>
          <span>Anchored late</span><i /><code>{snapshot.totals.anchored_late_forecasts} WINDOWS · {snapshot.totals.anchored_late_batches} ROOTS · EXCLUDED FROM PROOF + SCORING</code>
        </div>
        <div className={`docket-row late ${snapshot.totals.pending_resolution > 0 ? 'alert' : ''}`}>
          <span>Pending resolution</span><i /><code>{snapshot.totals.pending_resolution} WINDOWS · PUBLISHED, NOT YET SCORED</code>
        </div>
        <div className="docket-row"><span>License</span><i /><code>MIT</code></div>
      </section>

      <section className="findings" aria-label="Findings">
        <h2 className="section-head"><span>§ 1</span> Resolve &amp; score</h2>
        <div className="current-model-head">
          <div><span>CURRENT MODEL</span><code>{currentModel.model_hash}</code></div>
          <p>Primary reading · sealed version only</p>
        </div>
        <div className="score-samples">
          <ScoreCard
            title="All evaluated windows"
            description="Current model only; PASS and VETO together."
            sample={currentModel.all_evaluated_windows}
          />
          <ScoreCard
            title="Risk-gate passed for execution"
            description="Current model only; first recorded gate ruling was PASS."
            sample={currentModel.risk_gate_passed}
          />
        </div>
        <article className="model-breakdown" aria-label="Score breakdown by sealed model hash">
          <div className="model-breakdown-head">
            <div><h3>Immutable model versions</h3><p>Each row is derived from the model_hash already sealed inside its forecast payload.</p></div>
            <em>{modelBreakdown.length} VERSIONS · CURRENT FIRST</em>
          </div>
          <div className="model-table-wrap">
            <table className="model-table">
              <thead><tr><th>MODEL HASH</th><th>SAMPLE</th><th>N</th><th>MEAN p_AGENT</th><th>MEAN p_MARKET</th><th>BRIER A / M</th><th>SKILL</th><th>95% BOOTSTRAP CI</th></tr></thead>
              <tbody>
                {orderedModelBreakdown.flatMap((model) => ([
                  { key: `${model.model_hash}-all`, model, label: 'ALL EVALUATED', sample: model.all_evaluated_windows },
                  { key: `${model.model_hash}-pass`, model, label: 'RISK-GATE PASS', sample: model.risk_gate_passed },
                ])).map(({ key, model, label, sample }, index) => (
                  <tr key={key} className={index % 2 === 0 ? 'model-start' : ''}>
                    <td>{index % 2 === 0 && <><code>{short(model.model_hash, 10, 8)}</code><small>{model.model_hash === snapshot.production.model_hash ? 'CURRENT PRODUCTION' : 'HISTORICAL VERSION'}</small></>}</td>
                    <td>{label}</td>
                    <td className="model-n">{sample.n}<small>{sample.n < 100 ? 'TOO SMALL' : 'USABLE'}</small></td>
                    <td>{sample.mean_p_agent?.toFixed(3) ?? '—'}</td>
                    <td>{sample.mean_p_market?.toFixed(3) ?? '—'}</td>
                    <td>{sample.brier_agent?.toFixed(3) ?? '—'} / {sample.brier_market?.toFixed(3) ?? '—'}</td>
                    <td className="model-skill">{sample.skill_score === null ? '—' : signed(sample.skill_score)}</td>
                    <td>{sample.skill_score_ci_95 === null ? '—' : `[${signed(sample.skill_score_ci_95.low)}, ${signed(sample.skill_score_ci_95.high)}]`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
        <article className="mixed-history" aria-label="Mixed-model historical total">
          <div className="mixed-history-head">
            <div><h3>Mixed-model historical total</h3><p>Context only. Never compare this total with a single model version.</p></div>
            <em>SECONDARY · {modelBreakdown.length} MODELS COMBINED</em>
          </div>
          <div className="mixed-history-grid">
            {[
              { label: 'ALL EVALUATED', sample: allEvaluated },
              { label: 'RISK-GATE PASS', sample: riskPassed },
            ].map(({ label, sample }) => (
              <div key={label}>
                <span>{label}</span>
                <p><b>{sample.skill_score === null ? '—' : signed(sample.skill_score)}</b><strong>N = {sample.n}</strong></p>
                <small>MEAN p_AGENT {sample.mean_p_agent?.toFixed(3) ?? '—'} · p_MARKET {sample.mean_p_market?.toFixed(3) ?? '—'} · BRIER A/M {sample.brier_agent?.toFixed(3) ?? '—'} / {sample.brier_market?.toFixed(3) ?? '—'}</small>
              </div>
            ))}
          </div>
        </article>
        <div className="exclusion-panel" aria-label="Windows excluded from scoring">
          <div className="exclusion-title"><span>EXCLUDED FROM SCORING</span><small>Every reason stays visible; counts may overlap.</small></div>
          <div><b>{exclusions.anchored_late}</b><span>ANCHORED LATE</span></div>
          <div><b>{exclusions.unanchored}</b><span>UNANCHORED</span></div>
          <div><b>{exclusions.voided}</b><span>VOIDED</span></div>
          <div><b>{exclusions.unresolved}</b><span>UNRESOLVED / UNREVEALED</span></div>
          <div><b>{exclusions.resolved_without_score}</b><span>RESOLVED WITHOUT SCORE</span></div>
          <div><b>{exclusions.missing_risk_decision}</b><span>MISSING GATE RULING</span></div>
        </div>
        <p className="footnote">
          <sup>*</sup> Scores update from append-only resolution events. They use only the sealed
          agent probability and the market probability captured at commit; there is no backfill
          or historical repricing. The interval is a deterministic 1,000-resample, 95% bootstrap.
        </p>
      </section>

      <section className="ledger" aria-label="Ledger of sealed forecasts">
        <div className="ledger-head">
          <h2 className="section-head"><span>§ 2</span> Ledger of sealed forecasts</h2>
          <p className="legend"><i className="key agent" /> agent&ensp;<i className="key market" /> market&ensp;·&ensp;risk gating never filters the recorded sample</p>
        </div>
        <div className="table" role="table" aria-label="Production forecasts">
          <div className="tr th" role="row">
            <span>WINDOW</span><span>COMMITTED p(YES)</span><span className="num">AGENT</span><span className="num">MARKET</span><span>GATE</span><span>OUTCOME</span><span className="num">BRIER A / M</span>
          </div>
          {forecasts.map((item) => {
            const agentCloser = item.brierAgent !== null && item.brierMarket !== null && item.brierAgent < item.brierMarket;
            return (
              <button key={item.id} className={`tr ${selected.id === item.id ? 'selected' : ''}`} role="row" onClick={() => setSelectedId(item.id)}>
                <span className="win"><b>{item.asset}</b> / {item.interval}</span>
                <span><Dumbbell agent={item.pAgent} market={item.pMarket} compact /></span>
                <span className="num">{pct(item.pAgent / 100)}</span>
                <span className="num">{pct(item.pMarket / 100)}</span>
                <span><em className={item.allowed ? 'badge pass' : 'badge veto'}>{item.allowed ? '✓ PASS' : '× VETO'}</em></span>
                <span className="outcome">{item.outcome ? `RESOLVED ${item.outcome}` : 'PENDING'}</span>
                <span className="num briers">
                  <b className={agentCloser ? 'closer' : ''}>{item.brierAgent?.toFixed(3) ?? '—'}</b>
                  {' / '}
                  <b className={!agentCloser && item.brierMarket !== null ? 'closer' : ''}>{item.brierMarket?.toFixed(3) ?? '—'}</b>
                </span>
              </button>
            );
          })}
        </div>

        <article className="exhibit" aria-label="Selected forecast detail">
          <div className="exhibit-head">
            <p className="eyebrow">EXHIBIT § 2.1 — SELECTED WINDOW</p>
            <h3>{selected.asset} / {selected.interval} <code>{selected.idShort}</code></h3>
            <em className={selected.allowed ? 'badge pass' : 'badge veto'}>{selected.allowed ? '✓ EXECUTION ELIGIBLE' : '× TRADE VETOED'}</em>
          </div>
          <Dumbbell agent={selected.pAgent} market={selected.pMarket} />
          <div className="exhibit-grid">
            <div><span>COMMITTED SIDE</span><b>{selected.side}</b></div>
            <div><span>EDGE AT COMMIT</span><b>{selected.edge.toFixed(2)} pp</b></div>
            <div><span>OUTCOME</span><b>{selected.outcome ? `RESOLVED ${selected.outcome}` : 'PENDING'}</b></div>
            <div><span>RISK RULING</span><b className="ruling">{selected.allowed ? 'edge inside the 3–10 pp execution band' : selected.reason === 'model-disagreement' ? 'disagreement above ceiling — recorded, not traded' : 'edge below execution floor — recorded, not traded'}</b></div>
          </div>
          <p className="evidence"><span>EVIDENCE DIGEST</span><code>{selected.evidence}</code></p>
        </article>
      </section>

      <section className="chain" aria-label="Proof chain">
        <h2 className="section-head"><span>§ 3</span> Proof chain</h2>
        <ol className="steps">
          <li><span>01</span><b>Snapshot</b><small>market midpoint frozen</small><em>✓ DONE</em></li>
          <li><span>02</span><b>Commit</b><small>salted Keccak-256 preimage</small><em>✓ DONE</em></li>
          <li><span>03</span><b>Anchor</b><small>Merkle root on Shannon</small><em>✓ DONE</em></li>
          <li><span>04</span><b>Score</b><small>Brier vs market baseline</small><em>{scored ? '✓ DONE' : 'PENDING'}</em></li>
        </ol>
      </section>

      <section className="verify" id="verify" aria-label="Independent verification">
        <div className="verify-copy">
          <h2 className="section-head"><span>§ 4</span> Independent verification</h2>
          <p className="verify-title">Do not trust this document.<br />Recompute it.</p>
          <p className="verify-body">
            A clean clone reproduces commitments and Merkle proofs, checks every production
            root from the submitter, reads expiry and outcome from Shannon, and matches each
            receipt, block time, emitter, root, and leaf count. New-format anchors also bind
            the preceding ledger head. Late and pending records stay visible but unscored.
          </p>
          <div className="verify-facts">
            <p><span>ROOT</span><code>{root}</code></p>
            <p><span>ANCHOR TX</span><a href={explorer} target="_blank" rel="noreferrer"><code>{tx}</code> ↗</a></p>
          </div>
        </div>
        <div className="enclosure" aria-label="Clean clone verification commands">
          <div className="enclosure-head"><span>ENCLOSURE A — proof-edge / clean clone</span><button type="button" onClick={copyVerification}>{copied ? 'COPIED ✓' : 'COPY COMMANDS'}</button></div>
          <pre><code>{verificationCommands}</code></pre>
          <div className="enclosure-foot"><span>EXPECTED</span><b>{snapshot.totals.provable_forecasts} / {snapshot.totals.forecasts} PROVABLE · {snapshot.totals.on_time_anchors} / {snapshot.totals.anchors} ON-TIME ROOTS · {completenessFailures} FAILURES · {completenessPendingRoots} PENDING AFTER WATERMARK</b></div>
        </div>
      </section>

      <footer className="colophon">
        <span>PROOF·EDGE — ESTIMATOR-AGNOSTIC MEASUREMENT LAYER · MIT</span>
        <span>RENDERED VERBATIM FROM {snapshot.generated_from.toUpperCase()}</span>
        <span>ROOT {short(root, 10, 6)}</span>
      </footer>
    </main>
  );
}
