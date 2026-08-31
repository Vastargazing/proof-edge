'use client';

import { useState } from 'react';
import snapshot from './forecast-data.json';

type Bin = {
  index: number;
  lower: number;
  upper: number;
  n: number;
  mean_predicted: number | null;
  observed_frequency: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
};
type Series = { agent: Bin[]; market: Bin[] };
type Calibration = {
  all_evaluated_windows: Series;
  current_model: { model_hash: string | null } & Series;
};

// Snapshots published before this key existed stay renderable: the section
// says so instead of throwing on a missing property.
const calibration: Calibration | null = 'calibration' in snapshot.resolve_score
  ? (snapshot.resolve_score.calibration as Calibration)
  : null;

const LEFT = 76;
const TOP = 16;
const SIZE = 440;
const RIGHT = LEFT + SIZE;
const BOTTOM = TOP + SIZE;
const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1];

const px = (probability: number) => LEFT + probability * SIZE;
const py = (frequency: number) => BOTTOM - frequency * SIZE;
const drawn = (bins: Bin[]) => bins.filter((bin) => bin.n > 0);
const label = (bin: Bin) => `[${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)}${bin.upper === 1 ? ']' : ')'}`;
const path = (bins: Bin[]) => drawn(bins)
  .map((bin, index) => `${index === 0 ? 'M' : 'L'}${px(bin.mean_predicted!).toFixed(2)},${py(bin.observed_frequency!).toFixed(2)}`)
  .join(' ');

// Radius grows with the square root of n, so a bin holding ten times as many
// sealed forecasts does not swamp the plot by a factor of ten.
const radius = (bin: Bin, largest: number) => 3 + 6 * Math.sqrt(bin.n / largest);

function Layer({ bins, largest, kind }: { bins: Bin[]; largest: number; kind: 'agent' | 'market' }) {
  return (
    <g className={`cal-layer ${kind}`}>
      {drawn(bins).map((bin) => (
        <line
          key={`bar-${bin.index}`}
          className="cal-bar"
          x1={px(bin.mean_predicted!)}
          x2={px(bin.mean_predicted!)}
          y1={py(bin.wilson_low!)}
          y2={py(bin.wilson_high!)}
        />
      ))}
      <path className="cal-line" d={path(bins)} />
      {drawn(bins).map((bin) => (
        <circle
          key={`dot-${bin.index}`}
          className="cal-dot"
          cx={px(bin.mean_predicted!)}
          cy={py(bin.observed_frequency!)}
          r={radius(bin, largest)}
        >
          <title>
            {`${kind === 'agent' ? 'AGENT' : 'MARKET'} ${label(bin)} · n=${bin.n}`
              + ` · predicted ${bin.mean_predicted!.toFixed(4)}`
              + ` · observed ${bin.observed_frequency!.toFixed(4)}`
              + ` · 95% Wilson [${bin.wilson_low!.toFixed(4)}, ${bin.wilson_high!.toFixed(4)}]`}
          </title>
        </circle>
      ))}
    </g>
  );
}

export default function CalibrationChart() {
  const [slice, setSlice] = useState<'current' | 'mixed'>('current');

  if (calibration === null) {
    return (
      <article className="calibration" aria-label="Reliability diagram">
        <div className="calibration-head">
          <div><h3>Reliability of the sealed probabilities</h3><p>Predicted probability against observed frequency.</p></div>
          <em>NO DATA YET</em>
        </div>
        <p className="calibration-caption">
          This snapshot predates the diagram. It carries no <code>resolve_score.calibration</code> key
          (<code>dashboard/app/forecast-data.json</code>), so there is nothing to draw; the next publisher
          run adds it. Nothing is inferred from the aggregate in the meantime.
        </p>
      </article>
    );
  }

  const active = slice === 'current' ? calibration.current_model : calibration.all_evaluated_windows;
  const agent = active.agent;
  const market = active.market;
  const n = agent.reduce((total, bin) => total + bin.n, 0);
  // One scale for both layers, or the quieter series would read as the larger one.
  const largest = Math.max(1, ...agent.map((bin) => bin.n), ...market.map((bin) => bin.n));
  const emptyAgent = agent.filter((bin) => bin.n === 0);
  const emptyMarket = market.filter((bin) => bin.n === 0);
  const modelHash = calibration.current_model.model_hash;

  return (
    <article className="calibration" aria-label="Reliability diagram">
      <div className="calibration-head">
        <div>
          <h3>Reliability of the sealed probabilities</h3>
          <p>Predicted p(YES) against the frequency the market actually resolved YES. N = {n}.</p>
        </div>
        <div className="calibration-toggle" role="group" aria-label="Sample slice">
          <button type="button" className={slice === 'current' ? 'on' : ''} onClick={() => setSlice('current')}>CURRENT MODEL</button>
          <button type="button" className={slice === 'mixed' ? 'on' : ''} onClick={() => setSlice('mixed')}>MIXED HISTORY</button>
        </div>
      </div>

      <div className="calibration-plot">
        <svg
          viewBox={`0 0 ${RIGHT + 22} ${BOTTOM + 52}`}
          role="img"
          aria-label={`Reliability diagram over ${n} sealed and resolved forecasts. `
            + drawn(agent).map((bin) => `Agent ${label(bin)}: predicted ${bin.mean_predicted!.toFixed(2)}, observed ${bin.observed_frequency!.toFixed(2)}, n ${bin.n}.`).join(' ')}
        >
          <g className="cal-grid" aria-hidden>
            {agent.map((bin) => (
              <line key={`edge-${bin.index}`} x1={px(bin.lower)} x2={px(bin.lower)} y1={TOP} y2={BOTTOM} className="cal-edge" />
            ))}
            {AXIS_TICKS.map((tick) => (
              <line key={`h-${tick}`} x1={LEFT} x2={RIGHT} y1={py(tick)} y2={py(tick)} className="cal-rule" />
            ))}
            <rect x={LEFT} y={TOP} width={SIZE} height={SIZE} className="cal-frame" />
          </g>

          {/* Named in the legend, not on the line: the market series tracks the
              diagonal closely enough that an in-plot label would sit on top of it. */}
          <line className="cal-ideal" x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} />

          <Layer bins={market} largest={largest} kind="market" />
          <Layer bins={agent} largest={largest} kind="agent" />

          <g className="cal-axis" aria-hidden>
            {AXIS_TICKS.map((tick) => (
              <text key={`yl-${tick}`} x={LEFT - 12} y={py(tick) + 3.5} textAnchor="end">{tick.toFixed(2)}</text>
            ))}
            {AXIS_TICKS.map((tick) => (
              <text key={`xl-${tick}`} x={px(tick)} y={BOTTOM + 18} textAnchor="middle">{tick.toFixed(2)}</text>
            ))}
            <text className="cal-axis-title" x={LEFT + SIZE / 2} y={BOTTOM + 40} textAnchor="middle">PREDICTED p(YES) — SEALED BEFORE RESOLUTION</text>
            <text className="cal-axis-title" x={-(TOP + SIZE / 2)} y={18} textAnchor="middle" transform="rotate(-90)">OBSERVED FREQUENCY</text>
          </g>
        </svg>
      </div>

      <div className="calibration-legend">
        <span><i className="key agent" /> agent · 95% Wilson bars</span>
        <span><i className="key market" /> market midpoint at commit · baseline</span>
        <span><i className="key ideal" /> perfect calibration</span>
        <span>point radius ∝ √n{slice === 'current' && modelHash ? <> · sealed model <code>{modelHash.slice(0, 10)}…</code></> : null}</span>
      </div>

      <p className="calibration-caption">
        Every point is a probability that was anchored on Somnia before its market expired and scored
        against the outcome that arrived afterwards — {slice === 'current'
          ? 'the windows the current-model cards above score'
          : 'the windows the mixed-model historical total above scores'}.
        No point here could be added, removed or reselected after the fact: the bins are whatever the
        sealed bytes already contained. Bars are 95% Wilson intervals on the observed frequency.
        {emptyAgent.length === 0 && emptyMarket.length === 0
          ? ' All ten bins hold at least one forecast.'
          : ` Empty bins are not drawn: agent ${emptyAgent.length === 0 ? 'none' : emptyAgent.map(label).join(', ')};`
            + ` market ${emptyMarket.length === 0 ? 'none' : emptyMarket.map(label).join(', ')}.`}
        {' '}(<code>dashboard/app/forecast-data.json</code>, key <code>resolve_score.calibration</code>).
      </p>
    </article>
  );
}
