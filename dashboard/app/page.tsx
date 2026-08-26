'use client';

import { useMemo, useState } from 'react';
import snapshot from './forecast-data.json';

type Forecast = {
  id: string;
  asset: 'BTC' | 'ETH';
  interval: string;
  pAgent: number;
  pMarket: number;
  edge: number;
  allowed: boolean;
  side: 'YES' | 'NO';
  evidence: string;
};

const forecasts: Forecast[] = snapshot.production.forecasts.map((item) => ({
  id: short(item.id, 4, 4),
  asset: item.asset as Forecast['asset'],
  interval: item.interval_sec === 3600 ? '1h' : `${item.interval_sec / 60}m`,
  pAgent: item.p_agent * 100,
  pMarket: item.p_market * 100,
  edge: item.edge * 100,
  allowed: item.allowed,
  side: item.side as Forecast['side'],
  evidence: short(item.evidence_digest, 8, 4),
}));

const root = snapshot.production.root;
const tx = snapshot.production.transaction_hash;
const explorer = `https://shannon-explorer.somnia.network/tx/${tx}`;
const repository = 'https://github.com/Vastargazing/proof-edge';
const verificationCommands = `git clone --recurse-submodules ${repository}.git
cd proof-edge
npm ci
npm run check
npm run verify:log
npm run verify:chain`;
function short(value: string, start = 8, end = 6) { return `${value.slice(0, start)}…${value.slice(-end)}`; }

export default function Home() {
  const [selectedId, setSelectedId] = useState(forecasts[0].id);
  const [copied, setCopied] = useState(false);
  const selected = useMemo(() => forecasts.find((item) => item.id === selectedId) ?? forecasts[0], [selectedId]);
  const productionSkill = snapshot.brier_skill.production_v1;
  const scored = productionSkill.n > 0;

  async function copyVerification() {
    await navigator.clipboard.writeText(verificationCommands);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Proof Edge home"><span className="brand-mark">P/E</span><span>PROOF·EDGE</span></a>
        <div className="network"><span className="pulse" /> SOMNIA SHANNON <b>LIVE</b></div>
        <a className="tx-link" href={explorer} target="_blank" rel="noreferrer">VIEW ANCHOR ↗</a>
      </header>

      <section className="intro" id="top">
        <div><p className="eyebrow">VERIFIABLE FORECAST RECORDER / V1</p><h1>Forecasts that can’t<br />move after the fact.</h1></div>
          <div className="intro-copy"><p>Bring any estimator. We freeze its probability, capture the market baseline, pass it through a risk gate, and score both after resolution.</p><div className="seal"><span>{snapshot.totals.forecasts}</span><small>FORECASTS<br />SEALED</small></div></div>
      </section>

      <section className="status-strip" aria-label="Recorder status">
        <div><span>PRODUCTION ROOT</span><code>{short(root, 12, 8)}</code></div>
        <div><span>MODEL HASH</span><code>{short(snapshot.production.model_hash, 14, 6)}</code></div>
        <div><span>BATCH EVIDENCE</span><strong>{snapshot.production.forecasts.length} / {snapshot.production.forecasts.length}</strong></div>
        <div><span>ON-CHAIN ROOTS</span><strong className="ok">ANCHORED ×{snapshot.totals.anchors}</strong></div>
        <div><span>PRODUCTION BSS</span><strong className={scored && productionSkill.skill_score! > 0 ? 'ok' : ''}>{scored ? productionSkill.skill_score!.toFixed(3) : 'AWAITING RESOLVE'}</strong></div>
      </section>

      <section className="workbench">
        <article className="signal-panel">
          <div className="panel-head"><div><p className="eyebrow">SELECTED WINDOW</p><h2><span className={`coin ${selected.asset.toLowerCase()}`}>{selected.asset === 'ETH' ? '◆' : '₿'}</span>{selected.asset} / {selected.interval}</h2></div><span className={`gate-pill ${selected.allowed ? 'pass' : 'blocked'}`}>{selected.allowed ? 'RISK GATE: PASS' : 'RISK GATE: BLOCKED'}</span></div>
          <div className="probability-grid">
            <div className="probability agent"><span>AGENT</span><b>{selected.pAgent.toFixed(2)}%</b><small>P(YES)</small></div>
            <div className="edge-readout"><span>EDGE</span><b>{selected.edge.toFixed(2)}<small>pp</small></b><i>{selected.side}</i></div>
            <div className="probability market"><span>MARKET</span><b>{selected.pMarket.toFixed(2)}%</b><small>AT COMMIT</small></div>
          </div>
          <div className="scale" aria-label={`Agent probability ${selected.pAgent} percent, market probability ${selected.pMarket} percent`}><div className="ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div><div className="track"><span className="range" style={{ left: `${Math.min(selected.pAgent, selected.pMarket)}%`, width: `${Math.abs(selected.pAgent - selected.pMarket)}%` }} /><span className="marker market-marker" style={{ left: `${selected.pMarket}%` }}><i>MARKET</i></span><span className="marker agent-marker" style={{ left: `${selected.pAgent}%` }}><i>AGENT</i></span></div></div>
          <div className="gate-explain"><div className="gate-icon">{selected.allowed ? '✓' : '×'}</div><div><b>{selected.allowed ? 'Execution eligible' : 'Trade vetoed — forecast still recorded'}</b><p>{selected.allowed ? 'Absolute edge sits inside the 3–10 pp execution band.' : 'Disagreement exceeds the configured ceiling. The full sample remains unbiased.'}</p></div><code>{selected.id}</code></div>
        </article>

        <aside className="proof-panel">
          <div className="panel-head compact"><div><p className="eyebrow">PROOF CHAIN</p><h2>Immutable by construction</h2></div><span className="proof-dot">●</span></div>
          <ol className="proof-steps"><li className="done"><span>01</span><div><b>Snapshot</b><small>Market midpoint frozen</small></div><em>DONE</em></li><li className="done"><span>02</span><div><b>Commit</b><small>Keccak-256 preimage</small></div><em>DONE</em></li><li className="done"><span>03</span><div><b>Anchor</b><small>Merkle root on Shannon</small></div><em>DONE</em></li><li className={scored ? 'done' : ''}><span>04</span><div><b>Resolve & score</b><small>Brier vs market baseline</small></div><em>{scored ? 'DONE' : 'PENDING'}</em></li></ol>
          <div className="hash-card"><span>EVIDENCE DIGEST</span><code>{selected.evidence}</code><small>Full observation payload retained locally</small></div>
          <a className="primary-link" href={explorer} target="_blank" rel="noreferrer">VERIFY ON EXPLORER <span>↗</span></a>
        </aside>
      </section>

      <section className="ledger">
        <div className="ledger-title"><div><p className="eyebrow">LIVE LEDGER</p><h2>Every evaluation enters the record.</h2></div><p>Risk controls execution, never the calibration sample.</p></div>
        <div className="table" role="table" aria-label="Forecast ledger">
          <div className="table-row table-head" role="row"><span>WINDOW</span><span>AGENT</span><span>MARKET</span><span>EDGE</span><span>DECISION</span><span>PROOF</span></div>
          {forecasts.map((item) => <button className={`table-row ${selected.id === item.id ? 'selected' : ''}`} role="row" key={item.id} onClick={() => setSelectedId(item.id)}><span><i className={`asset-dot ${item.asset.toLowerCase()}`} /> <b>{item.asset}</b> / {item.interval}</span><span>{item.pAgent.toFixed(2)}%</span><span>{item.pMarket.toFixed(2)}%</span><span className="edge-cell">{item.edge.toFixed(2)} pp</span><span><em className={item.allowed ? 'decision-pass' : 'decision-block'}>{item.allowed ? 'PASS' : 'BLOCK'}</em></span><span><code>{item.id}</code></span></button>)}
        </div>
      </section>

      <section className="verifier" id="verify">
        <div className="verifier-copy">
          <p className="eyebrow">INDEPENDENT VERIFICATION</p>
          <h2>Don’t trust the dashboard.<br />Verify the root yourself.</h2>
          <p>A clean clone reproduces every commitment and Merkle proof, then independently matches the Shannon receipt, block time, emitter, root, and leaf count.</p>
          <div className="verification-facts">
            <div><span>ROOT</span><code>{root}</code></div>
            <div><span>ANCHOR TX</span><a href={explorer} target="_blank" rel="noreferrer"><code>{tx}</code> ↗</a></div>
          </div>
        </div>
        <div className="terminal-card" aria-label="Clean clone verification commands">
          <div className="terminal-head"><span>proof-edge / clean clone</span><button type="button" onClick={copyVerification}>{copied ? 'COPIED ✓' : 'COPY COMMANDS'}</button></div>
          <pre><code>{verificationCommands}</code></pre>
          <div className="terminal-foot"><span>EXPECTED</span><b>10 / 10 FORECASTS · 2 / 2 ROOTS · 0 FAILURES</b></div>
        </div>
      </section>

      <footer><span>PROOF·EDGE / ESTIMATOR-AGNOSTIC MEASUREMENT LAYER</span><span>ROOT {short(root, 10, 6)}</span></footer>
    </main>
  );
}
