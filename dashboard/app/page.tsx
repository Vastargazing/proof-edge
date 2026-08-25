'use client';

import { useMemo, useState } from 'react';

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

const forecasts: Forecast[] = [
  { id: '0x…961a', asset: 'ETH', interval: '15m', pAgent: 19.11, pMarket: 11.75, edge: 7.36, allowed: true, side: 'YES', evidence: '0xedce…404a' },
  { id: '0x…9619', asset: 'BTC', interval: '15m', pAgent: 16.61, pMarket: 10.60, edge: 6.01, allowed: true, side: 'YES', evidence: '0x25fa…220e' },
  { id: '0x…9618', asset: 'ETH', interval: '1h', pAgent: 27.28, pMarket: 30.30, edge: 3.02, allowed: true, side: 'NO', evidence: '0xe961…f922' },
  { id: '0x…9617', asset: 'BTC', interval: '1h', pAgent: 22.13, pMarket: 32.35, edge: 10.22, allowed: false, side: 'NO', evidence: '0x33ec…5d97' },
];

const root = '0x5361b3cc07f7adcd943cea288f75f97b8d565bd6d47922ddaf02b158ae8fb48d';
const tx = '0xce296f66cd53a98ad45c6853f79dd4adb5f7412886e2a4af58fa9fb75ced1613';
const explorer = `https://shannon-explorer.somnia.network/tx/${tx}`;
const short = (value: string, start = 8, end = 6) => `${value.slice(0, start)}…${value.slice(-end)}`;

export default function Home() {
  const [selectedId, setSelectedId] = useState(forecasts[0].id);
  const selected = useMemo(() => forecasts.find((item) => item.id === selectedId) ?? forecasts[0], [selectedId]);

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Proof Edge home"><span className="brand-mark">P/E</span><span>PROOF·EDGE</span></a>
        <div className="network"><span className="pulse" /> SOMNIA SHANNON <b>LIVE</b></div>
        <a className="tx-link" href={explorer} target="_blank" rel="noreferrer">VIEW ANCHOR ↗</a>
      </header>

      <section className="intro" id="top">
        <div><p className="eyebrow">VERIFIABLE FORECAST RECORDER / V1</p><h1>Forecasts that can’t<br />move after the fact.</h1></div>
        <div className="intro-copy"><p>Bring any estimator. We freeze its probability, capture the market baseline, pass it through a risk gate, and score both after resolution.</p><div className="seal"><span>10</span><small>FORECASTS<br />SEALED</small></div></div>
      </section>

      <section className="status-strip" aria-label="Recorder status">
        <div><span>PRODUCTION ROOT</span><code>{short(root, 12, 8)}</code></div>
        <div><span>MODEL HASH</span><code>0x6a7015d65b…257755</code></div>
        <div><span>V1 EVIDENCE</span><strong>4 / 4</strong></div>
        <div><span>ON-CHAIN CHECK</span><strong className="ok">VERIFIED ×2</strong></div>
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
          <ol className="proof-steps"><li className="done"><span>01</span><div><b>Snapshot</b><small>Market midpoint frozen</small></div><em>DONE</em></li><li className="done"><span>02</span><div><b>Commit</b><small>Keccak-256 preimage</small></div><em>DONE</em></li><li className="done"><span>03</span><div><b>Anchor</b><small>Merkle root on Shannon</small></div><em>DONE</em></li><li><span>04</span><div><b>Resolve & score</b><small>Brier vs market baseline</small></div><em>PENDING</em></li></ol>
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

      <footer><span>PROOF·EDGE / ESTIMATOR-AGNOSTIC MEASUREMENT LAYER</span><span>ROOT {short(root, 10, 6)}</span></footer>
    </main>
  );
}
