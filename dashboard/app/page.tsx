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

const repository = 'https://github.com/Vastargazing/proof-edge';
const verificationCommands = `git clone --recurse-submodules ${repository}.git
cd proof-edge
npm ci
npm run check
npm run verify:log
npm run verify:chain`;

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
const production = snapshot.brier_skill.production_v1;
const allResolved = snapshot.brier_skill.all_resolved;
const scored = production.n > 0;
const brierScaleMax = 0.25;

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
          <h1>Forecasts that cannot move after the&nbsp;fact.</h1>
          <p className="abstract">
            Bring any estimator. Proof·Edge freezes its probability and the market&rsquo;s
            contemporaneous price before expiry, seals both under a salted Keccak-256
            commitment, anchors the batch root on Somnia Shannon, and scores everything
            after resolution &mdash; the losses as publicly as the wins.
          </p>
        </div>
        <figure className="stamp-figure" aria-label={`${snapshot.totals.forecasts} forecasts sealed, ${snapshot.totals.anchors} roots anchored`}>
          <svg className="stamp" viewBox="0 0 200 200" aria-hidden>
            <defs><path id="stamp-arc" d="M100,100 m-72,0 a72,72 0 1,1 144,0 a72,72 0 1,1 -144,0" /></defs>
            <circle cx="100" cy="100" r="95" className="ring-outer" />
            <circle cx="100" cy="100" r="88" className="ring-outer thin" />
            <circle cx="100" cy="100" r="56" className="ring-inner" />
            <text className="arc-text"><textPath href="#stamp-arc">ANCHORED ON SOMNIA SHANNON · KECCAK-256 SEALED · MERKLE PROVEN ·</textPath></text>
            <text x="100" y="96" textAnchor="middle" className="stamp-count">{snapshot.totals.forecasts}</text>
            <text x="100" y="116" textAnchor="middle" className="stamp-sub">FORECASTS SEALED</text>
            <text x="100" y="130" textAnchor="middle" className="stamp-sub">ROOTS ×{snapshot.totals.anchors}</text>
          </svg>
        </figure>
      </section>

      <section className="docket" aria-label="Document references">
        <div className="docket-row"><span>Production root</span><i /><code>{root}</code></div>
        <div className="docket-row"><span>Anchor transaction</span><i /><a href={explorer} target="_blank" rel="noreferrer"><code>{short(tx, 10, 8)}</code> ↗</a></div>
        <div className="docket-row"><span>Model hash</span><i /><code>{short(snapshot.production.model_hash, 10, 8)}</code></div>
        <div className="docket-row"><span>Estimator</span><i /><code>dreamdex-ec-oracle-follow-strike-adapter</code></div>
        <div className="docket-row"><span>Ledger</span><i /><code>{snapshot.generated_from}</code></div>
        <div className="docket-row"><span>License</span><i /><code>MIT</code></div>
      </section>

      <section className="findings" aria-label="Findings">
        <h2 className="section-head"><span>§ 1</span> Findings</h2>
        <div className="tiles">
          <article className="tile">
            <h3>Brier skill vs market</h3>
            <p className="hero">{scored ? signed(production.skill_score!) : '—'}</p>
            <p className="tile-sub">production batch · n = {production.n}{scored && production.skill_score! < 0 ? ' · market ahead' : ''}</p>
          </article>
          <article className="tile">
            <h3>Mean Brier, production <small>(lower is better)</small></h3>
            <div className="bars" role="img" aria-label={`Agent ${production.brier_agent?.toFixed(3)}, market ${production.brier_market?.toFixed(3)}`}>
              <div className="bar-row"><span>AGENT</span><i className="bar agent" style={{ width: `${Math.min((production.brier_agent ?? 0) / brierScaleMax, 1) * 100}%` }} /><b>{production.brier_agent?.toFixed(3) ?? '—'}</b></div>
              <div className="bar-row"><span>MARKET</span><i className="bar market" style={{ width: `${Math.min((production.brier_market ?? 0) / brierScaleMax, 1) * 100}%` }} /><b>{production.brier_market?.toFixed(3) ?? '—'}</b></div>
            </div>
          </article>
          <article className="tile">
            <h3>Windows resolved</h3>
            <p className="hero">{allResolved.n}<small> / {snapshot.totals.forecasts}</small></p>
            <p className="tile-sub">every committed window scored</p>
          </article>
          <article className="tile">
            <h3>Roots anchored</h3>
            <p className="hero ok">{snapshot.totals.anchors}<small> / {snapshot.totals.anchors}</small></p>
            <p className="tile-sub">receipts re-verified on-chain</p>
          </article>
        </div>
        <p className="footnote">
          <sup>*</sup> A negative skill score is the honest reading of this sample: the market
          baseline is still ahead of the estimator. Proof·Edge exists to make this number
          impossible to fake &mdash; in either direction.
        </p>
      </section>

      <section className="ledger" aria-label="Ledger of sealed forecasts">
        <div className="ledger-head">
          <h2 className="section-head"><span>§ 2</span> Ledger of sealed forecasts</h2>
          <p className="legend"><i className="key agent" /> agent&ensp;<i className="key market" /> market&ensp;·&ensp;risk gating never filters this sample</p>
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
            A clean clone reproduces every commitment and Merkle proof from the published
            ledger, then independently matches the Shannon receipt, block time, emitter,
            root, and leaf count.
          </p>
          <div className="verify-facts">
            <p><span>ROOT</span><code>{root}</code></p>
            <p><span>ANCHOR TX</span><a href={explorer} target="_blank" rel="noreferrer"><code>{tx}</code> ↗</a></p>
          </div>
        </div>
        <div className="enclosure" aria-label="Clean clone verification commands">
          <div className="enclosure-head"><span>ENCLOSURE A — proof-edge / clean clone</span><button type="button" onClick={copyVerification}>{copied ? 'COPIED ✓' : 'COPY COMMANDS'}</button></div>
          <pre><code>{verificationCommands}</code></pre>
          <div className="enclosure-foot"><span>EXPECTED</span><b>10 / 10 FORECASTS · 2 / 2 ROOTS · 0 FAILURES</b></div>
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
