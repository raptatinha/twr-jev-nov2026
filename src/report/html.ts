import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { faviconLink } from '../favicon';
import { PRICES, PRICES_CHECKED_ON } from '../prices';
import type { ModelStats } from './stats';
import { pct, usd } from './stats';
import type { CalibrationBucket, Summary, SweepPoint } from './summary';

/**
 * Renders the results as ONE self-contained HTML page (inline CSS + SVG, no network).
 * Used as a Playwright attachment (Project 1 summary) and by `npm run dashboard`.
 * Colors: first three slots of a colorblind-validated categorical palette, light + dark.
 */
// Escape text before putting it in HTML, so a model name or an error message can't break the page.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Chart size in SVG units (it scales to the page), and the margins around the plot area.
const W = 880;
const H = 380;
const M = { top: 28, right: 32, bottom: 56, left: 72 };
// IW / IH: the inner width and height, where the data is drawn.
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

// Grid lines, tick labels and axis titles, shared by both charts. x() and y() map a value to a pixel.
function axes(xTicks: { v: number; label: string }[], yTicks: { v: number; label: string }[], x: (v: number) => number, y: (v: number) => number, xTitle: string, yTitle: string): string {
  const grid = yTicks
    .map((t) => `<line class="grid" x1="${M.left}" x2="${M.left + IW}" y1="${y(t.v)}" y2="${y(t.v)}"/><text class="tick" x="${M.left - 8}" y="${y(t.v) + 4}" text-anchor="end">${t.label}</text>`)
    .join('');
  const xs = xTicks.map((t) => `<text class="tick" x="${x(t.v)}" y="${M.top + IH + 18}" text-anchor="middle">${t.label}</text>`).join('');
  return `${grid}${xs}<line class="axis" x1="${M.left}" x2="${M.left + IW}" y1="${M.top + IH}" y2="${M.top + IH}"/>
    <text class="axis-title" x="${M.left + IW / 2}" y="${H - 6}" text-anchor="middle">${xTitle}</text>
    <text class="axis-title" transform="translate(14 ${M.top + IH / 2}) rotate(-90)" text-anchor="middle">${yTitle}</text>`;
}

/**
 * The threshold sweep chart: one dot per threshold, cost on x, accuracy on y.
 * The current threshold (ROUTE_ACT) is highlighted and always labelled.
 */
function sweepChart(points: SweepPoint[], act: number): string {
  if (points.length === 0) return '<p class="muted">No sweep yet: run Project 1, or the benchmark with Jev and the escalation model.</p>';
  // Scales: 10% headroom on cost; accuracy starts just below the lowest point, so differences are visible.
  const maxCost = Math.max(...points.map((p) => p.costPer1k)) * 1.1 || 1;
  const minAcc = Math.max(0, Math.floor((Math.min(...points.map((p) => p.accuracy)) - 0.05) * 10) / 10);
  const x = (v: number) => M.left + (v / maxCost) * IW;
  const y = (v: number) => M.top + IH - ((v - minAcc) / (1 - minAcc)) * IH;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: f * maxCost, label: usd(f * maxCost) }));
  const yTicks = [];
  for (let v = minAcc; v <= 1.0001; v += 0.1) yTicks.push({ v, label: pct(v) });
  // One SVG path through all the points, in threshold order.
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.costPer1k).toFixed(1)},${y(p.accuracy).toFixed(1)}`).join(' ');
  // Only some thresholds get a text label, to keep the chart readable.
  const labelled = new Set([0, 0.5, 0.7, 0.8, 0.9, 1]);
  // Label only points with room around them: several thresholds can land on the same spot.
  const placed: { x: number; y: number }[] = [];
  // The current threshold always gets its label; reserve its room first so neighbours don't cover it.
  const cur = points.find((p) => Math.abs(p.threshold - act) < 0.001);
  if (cur) placed.push({ x: x(cur.costPer1k), y: y(cur.accuracy) });
  const hasRoom = (px: number, py: number) => placed.every((q) => Math.abs(q.x - px) > 90 || Math.abs(q.y - py) > 16);
  const dots = points
    .map((p) => {
      const current = Math.abs(p.threshold - act) < 0.001;
      const wanted = (labelled.has(p.threshold) || current) && (current || hasRoom(x(p.costPer1k), y(p.accuracy)));
      if (wanted && !current) placed.push({ x: x(p.costPer1k), y: y(p.accuracy) });
      const label = wanted ? `<text class="dlabel" x="${x(p.costPer1k) + 8}" y="${y(p.accuracy) - 8}">${current ? `t=${p.threshold} (current)` : `t=${p.threshold}`}</text>` : '';
      return `<g class="mark"><circle class="hit" cx="${x(p.costPer1k)}" cy="${y(p.accuracy)}" r="12"/><circle class="dot s1${current ? ' current' : ''}" cx="${x(p.costPer1k)}" cy="${y(p.accuracy)}" r="${current ? 6 : 4.5}"/>
        <title>threshold ${p.threshold}: accuracy ${pct(p.accuracy)}, ${usd(p.costPer1k)} per 1k decisions, ${pct(p.escalated)} escalated</title></g>${label}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Threshold sweep: accuracy against cost per 1,000 decisions">${axes(xTicks, yTicks, x, y, 'cost per 1,000 decisions', 'accuracy')}<path class="line s1" d="${line}"/>${dots}</svg>`;
}

/**
 * The calibration chart: stated confidence (x) vs. how often the answer was right (y), Jev vs. one LLM.
 * Dot size grows with the number of answers in the bucket. The diagonal is "perfectly calibrated".
 */
function calibrationChart(jev: CalibrationBucket[], llm: CalibrationBucket[], llmName: string | null): string {
  const has = (b: CalibrationBucket[]) => b.some((x) => x.count > 0);
  if (!has(jev) && !has(llm)) return '<p class="muted">No graded answers yet.</p>';
  const x = (v: number) => M.left + v * IW;
  const y = (v: number) => M.top + IH - v * IH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ v, label: pct(v) }));
  // One series of dots. dx nudges Jev and the LLM apart so overlapping dots stay visible.
  const series = (buckets: CalibrationBucket[], cls: string, name: string, dx: number) =>
    buckets
      .filter((b) => b.count > 0 && b.accuracy !== null)
      .map((b) => {
        const mid = (b.from + b.to) / 2;
        const r = Math.min(10, 4 + Math.sqrt(b.count));
        return `<g class="mark"><circle class="hit" cx="${x(mid) + dx}" cy="${y(b.accuracy!)}" r="${r + 6}"/><circle class="dot ${cls}" cx="${x(mid) + dx}" cy="${y(b.accuracy!)}" r="${r}"/>
          <title>${name}, confidence ${b.from.toFixed(1)}-${b.to.toFixed(1)}: right ${pct(b.accuracy)} of the time (${b.count} answers)</title></g>`;
      })
      .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration: stated confidence against observed accuracy">${axes(ticks, ticks, x, y, 'stated confidence', 'how often it was right')}
    <line class="diag" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/><text class="dlabel muted" x="${x(0.62)}" y="${y(0.56)}">perfectly calibrated</text>
    ${series(jev, 's1', 'Jev', -4)}${series(llm, 's2', llmName ?? 'LLM', 4)}</svg>
    <div class="legend"><span><i class="sw s1"></i>Jev (calibrated, top probability)</span><span><i class="sw s2"></i>${esc(llmName ?? 'LLM')} (self-reported)</span></div>`;
}

// A single stacked bar: how many decisions Jev answered alone, and how many went to each LLM.
function splitBar(split: Summary['split'], models: Summary['pathModels']): string {
  const total = split.jev + split.cheap + split.strong;
  if (total === 0) return '<p class="muted">No routed decisions yet.</p>';
  const parts: [keyof typeof split, string, string][] = [
    ['jev', 's1', `${models.jev ?? 'jev'} answered alone`],
    ['cheap', 's2', `${models.cheap ?? 'medium-confidence LLM'} (medium confidence)`],
    ['strong', 's3', `${models.strong ?? 'low-confidence LLM'} (low confidence)`],
  ];
  const segs = parts
    .filter(([k]) => split[k] > 0)
    .map(([k, cls, name]) => `<div class="seg ${cls}" style="flex:${split[k]}" title="${name}: ${split[k]} of ${total} (${pct(split[k] / total)})"></div>`)
    .join('');
  const legend = parts.map(([k, cls, name]) => `<span><i class="sw ${cls}"></i>${name}: <b>${split[k]}</b> (${pct(split[k] / total)})</span>`).join('');
  return `<div class="bar" role="img" aria-label="Where the decisions went">${segs}</div><div class="legend">${legend}</div>`;
}

// 1234 -> "1,234 ms".
const ms = (v: number) => `${v.toLocaleString('en-US')} ms`;

// The four before/after tiles at the top: cost, accuracy, typical and slow (1 in 20) latency, plus the saving.
function kpis(s: Summary): string {
  if (!s.baseline && !s.routed) return '';
  const tile = (name: string, before: string, after: string, note = '') =>
    `<div class="tile"><div class="tile-name">${name}</div><div class="tile-row"><span class="lab">before</span><span class="num">${before}</span></div><div class="tile-row"><span class="lab">after</span><span class="num big">${after}</span></div>${note ? `<div class="tile-note">${note}</div>` : ''}</div>`;
  const b = s.baseline;
  const r = s.routed;
  // "62% cheaper" and "10.2x faster" (or slower), only when both sides exist.
  const saving = b && r && b.costPer1k > 0 ? `${Math.round((1 - r.costPer1k / b.costPer1k) * 100)}% cheaper` : '';
  const ratio = b && r && b.medianMs > 0 && r.medianMs > 0 ? b.medianMs / r.medianMs : null;
  const faster = ratio === null ? '' : ratio >= 1 ? `${ratio.toFixed(1)}x faster (typical)` : `${(1 / ratio).toFixed(1)}x slower (typical)`;
  return `<div class="tiles">
    ${tile('Cost per 1,000 decisions', b ? usd(b.costPer1k) : '-', r ? usd(r.costPer1k) : '-', saving ? `<b>${saving}</b>` : '')}
    ${tile('Accuracy', b ? pct(b.accuracy) : '-', r ? pct(r.accuracy) : '-')}
    ${tile('Typical latency', b ? `${ms(b.medianMs)}` : '-', r ? `${ms(r.medianMs)}` : '-', `${faster ? `<b>${faster}.</b> ` : ''}Half of the decisions were faster than this, half slower: the typical wait.`)}
    ${tile('Slow latency (1 in 20)', b ? `${ms(b.p95Ms)}` : '-', r ? `${ms(r.p95Ms)}` : '-', '19 of every 20 decisions were faster than this; 1 in 20 was slower. The slow tail users notice.')}
  </div>
  <p class="context">Before: every decision sent to ${esc(s.baselineModel ?? '-')}. After: route(task). Router overhead (Jev calls that escalated anyway): ${usd(s.overheadUsdPer1k)} per 1,000 decisions.</p>`;
}

/** "after · grok-4.7 (medium-confidence cases Jev escalated)" -> model name on top, phase and role underneath. */
function modelCell(label: string): string {
  const m = /^([a-z]+) · ([^ ]+)(?: \((.+)\))?$/.exec(label);
  if (!m) return esc(label);
  return `<span class="mname">${esc(m[2])}</span><span class="mrole">${m[1]}${m[3] ? ` · ${esc(m[3])}` : ''}</span>`;
}

// The per-model table, with a collapsible "What the columns mean".
function modelTable(rows: ModelStats[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map((r) => `<tr><td class="model">${modelCell(r.model)}</td><td class="n">${r.calls}${r.errors ? ` <span class="muted">(+${r.errors} errors)</span>` : ''}</td><td class="n">${r.medianMs.toLocaleString('en-US')} ms</td><td class="n">${r.p95Ms.toLocaleString('en-US')} ms</td><td class="n">${r.avgInput.toFixed(0)}</td><td class="n">${r.avgOutput.toFixed(0)}</td><td class="n">${usd(r.costPer1k)}</td><td class="n">${pct(r.accuracy)}</td><td class="n">${r.parseFailures}</td></tr>`)
    .join('');
  return `<table><thead><tr><th>model</th><th class="n">calls</th><th class="n">typical</th><th class="n">slow (1 in 20)</th><th class="n">in tokens</th><th class="n">out tokens</th><th class="n">$ / 1k</th><th class="n">accuracy</th><th class="n">parse fails</th></tr></thead><tbody>${body}</tbody></table>
  <details><summary>What the columns mean</summary><ul class="small explain">
    <li><b>before</b> rows: every decision sent to one model. <b>after</b> rows: the calls route(task) made. Jev looks at every decision first; the LLMs only see the cases Jev escalated, so their accuracy there is on the hardest cases.</li>
    <li><b>typical</b>: half of the calls were faster than this, half slower. <b>slow (1 in 20)</b>: 19 of every 20 calls were faster; 1 in 20 was slower.</li>
    <li><b>avg input / output tokens</b>: from each vendor's own <code>usage</code> field. Output includes reasoning (thinking) tokens. Vendors count tokens differently, so compare dollars, not tokens.</li>
    <li><b>$ / 1k decisions</b>: average cost per call × 1,000, priced with the table below.</li>
    <li><b>accuracy</b>: share of answers matching the labeled answer. <b>parse failures</b>: answers that weren't one of the allowed options.</li>
  </ul></details>`;
}

// The text under the sweep chart: what the current threshold gives, and the cheapest threshold with the best accuracy.
function sweepExplain(points: SweepPoint[], act: number, s: Summary): string {
  const to = esc(s.sweepModel ?? 'the escalation model');
  const medium = s.pathModels.cheap && s.pathModels.cheap !== s.sweepModel ? esc(s.pathModels.cheap) : null;
  const how = `<details open><summary>How to read it</summary><ul class="small explain">
    <li>The <b>threshold</b> is how sure Jev must be to answer alone. Below it, the case goes to ${to}.</li>
    <li>Each dot is one threshold, from 0 to 1. Left = cheaper, up = more accurate. <b>t=0</b>: Jev answers everything (cheapest). <b>t=1</b>: almost everything is escalated (you pay for Jev and ${to}).</li>
    <li>Look for the <b>bend</b>: the cheapest dot that is still as accurate as the dots to its right. That is a good threshold.</li>
    <li>No new API calls: it replays the answers Jev and ${to} already gave. This replay has two tiers (Jev, then ${to})${medium ? `, so it can differ a little from route(task), which sends medium-confidence cases to ${medium}` : ''}.</li>
  </ul></details>`;
  if (points.length === 0) return how;
  const best = Math.max(...points.map((p) => p.accuracy));
  // The "bend": among the thresholds with the best accuracy, the cheapest one.
  const bend = points.filter((p) => p.accuracy >= best - 0.0001).sort((a, b) => a.costPer1k - b.costPer1k)[0];
  const current = points.find((p) => Math.abs(p.threshold - act) < 0.001);
  const lines = [
    current ? `At the current threshold (<b>${act}</b>): accuracy <b>${pct(current.accuracy)}</b>, <b>${usd(current.costPer1k)}</b> per 1,000 decisions, ${pct(current.escalated)} escalated.` : '',
    `The cheapest threshold with the best accuracy (${pct(best)}) in this run is <b>${bend.threshold}</b>: ${usd(bend.costPer1k)} per 1,000 decisions, ${pct(bend.escalated)} escalated.`,
  ].filter(Boolean);
  return `<p class="small finding">${lines.join(' ')}</p>${how}`;
}

// The text under the calibration chart: how right each model was in its most confident bucket.
function calibrationExplain(jev: CalibrationBucket[], llm: CalibrationBucket[], llmName: string | null): string {
  const how = `<details open><summary>How to read it</summary><ul class="small explain">
    <li>Answers are grouped by the confidence the model gave (0.5–0.6, 0.6–0.7…). For each group: how often was it actually right?</li>
    <li><b>On the dashed line</b>: well calibrated, 0.8 means right 8 times out of 10. <b>Below the line</b>: overconfident, it says 0.9 but is right less often. <b>Above</b>: underconfident.</li>
    <li>Why it matters: route(task) trusts Jev above the threshold. That is only safe if the high-confidence answers really are right.</li>
    <li><b>Calibrated</b> (Jev): the probability Jev gave its chosen answer. TypeSafe trains it so the number matches reality: 0.8 should be right about 8 times in 10. <b>Self-reported</b> (${esc(llmName ?? 'the LLM')}): the confidence the LLM wrote about itself when we asked. Nothing trains that number to match how often it's right, so treat it as an opinion, not a measurement.</li>
    <li>Small groups (a few answers) jump around: bigger dots carry more weight. Calibrate on your own data, with enough cases.</li>
  </ul></details>`;
  const top = (b: CalibrationBucket[]) => b.filter((x) => x.count > 0).sort((a, c) => c.from - a.from)[0];
  const tj = top(jev);
  const tl = top(llm);
  const lines = [
    tj ? `When Jev said ${tj.from.toFixed(1)}–${tj.to.toFixed(1)}, it was right <b>${pct(tj.accuracy)}</b> of the time (${tj.count} answers).` : '',
    tl ? `When ${esc(llmName ?? 'the LLM')} said ${tl.from.toFixed(1)}–${tl.to.toFixed(1)}, it was right <b>${pct(tl.accuracy)}</b> of the time (${tl.count} answers).` : '',
  ].filter(Boolean);
  return `${lines.length ? `<p class="small finding">${lines.join(' ')}</p>` : ''}${how}`;
}

// The "each LLM alone vs. with Jev" table: two rows per LLM, with the saving and the speed-up.
function pairsSection(s: Summary): string {
  if (s.pairs.length === 0) return '';
  const pctChange = (from: number, to: number) => (from > 0 ? Math.round((1 - to / from) * 100) : 0);
  const rows = s.pairs
    .map((p) => {
      const saved = pctChange(p.alone.costPer1k, p.withJev.costPer1k);
      const faster = p.withJev.medianMs > 0 ? p.alone.medianMs / p.withJev.medianMs : 0;
      return `<tr class="pair-a"><td class="model" rowspan="2"><span class="mname">${esc(p.model)}</span><span class="mrole">${p.tasks} decisions</span></td>
        <td>alone</td><td class="n">${pct(p.alone.accuracy)}</td><td class="n">${usd(p.alone.costPer1k)}</td><td class="n">${ms(p.alone.medianMs)}</td><td class="n">${ms(p.alone.p95Ms)}</td><td class="n">-</td></tr>
        <tr class="pair-b"><td><b>+ Jev</b></td><td class="n"><b>${pct(p.withJev.accuracy)}</b></td><td class="n"><b>${usd(p.withJev.costPer1k)}</b><span class="delta">${saved >= 0 ? `${saved}% cheaper` : `${-saved}% more`}</span></td><td class="n"><b>${ms(p.withJev.medianMs)}</b><span class="delta">${faster >= 1 ? `${faster.toFixed(1)}x faster` : `${(1 / faster).toFixed(1)}x slower`}</span></td><td class="n"><b>${ms(p.withJev.p95Ms)}</b></td><td class="n">${pct(p.withJev.escalated)}</td></tr>`;
    })
    .join('');
  // The cheapest "+ Jev" setup gets a one-line finding under the table.
  const best = [...s.pairs].sort((a, b) => a.withJev.costPer1k - b.withJev.costPer1k)[0];
  return `<section class="card"><h2>Each LLM alone vs. with Jev in front</h2>
  <p class="card-intro">Same ${s.pairs[0].tasks} decisions for every model. <b>+ Jev</b>: Jev answers alone when its confidence is at least <b>${s.pairsThreshold}</b>; the rest go to that LLM (and you pay for both calls).</p>
  <div class="scroll"><table class="pairs"><thead><tr><th>model</th><th>setup</th><th class="n">accuracy</th><th class="n">$ / 1k</th><th class="n">typical</th><th class="n">slow (1 in 20)</th><th class="n">escalated</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="small finding">Cheapest setup: <b>${esc(best.model)} + Jev</b> at ${usd(best.withJev.costPer1k)} per 1,000 decisions, ${pct(best.withJev.accuracy)} accurate.</p>
  <details><summary>How this is computed</summary><ul class="small explain">
    <li>Replayed from this run's saved answers: every model answered every decision on its own, so no extra API calls were made for this table.</li>
    <li><b>alone</b>: that LLM's own answers, cost and latency.</li>
    <li><b>+ Jev</b>: for each decision, Jev's answer if Jev was sure enough; otherwise Jev's call plus that LLM's call (cost and latency added together). This is the two-tier version of route(task).</li>
    <li><b>escalated</b>: share of decisions that still went to the LLM. It's the same for every LLM, because it depends only on Jev.</li>
  </ul></details></section>`;
}

// The same sweep as a plain table, collapsed by default: for screen readers and exact numbers.
function sweepTable(points: SweepPoint[]): string {
  if (points.length === 0) return '';
  return `<details><summary>Sweep as a table</summary><table><thead><tr><th>threshold</th><th>accuracy</th><th>$ / 1k</th><th>escalated</th></tr></thead><tbody>${points
    .map((p) => `<tr><td>${p.threshold}</td><td>${pct(p.accuracy)}</td><td>${usd(p.costPer1k)}</td><td>${pct(p.escalated)}</td></tr>`)
    .join('')}</tbody></table></details>`;
}

/**
 * Testing With Renata theme (website/testingwithrenata-theme). Dark is the brand default; light follows the OS.
 * Chart series use brand-adjacent colors that pass the colorblind checks (teal, plum-pink, warm amber):
 * the brand's own teal/plum/warm-gray are too muted to tell apart as chart series.
 * Brand fonts are embedded only if assets/fonts/ exists locally (they are licensed, never committed).
 */
function fontFaces(): string {
  const dir = join(process.cwd(), 'assets', 'fonts');
  const face = (family: string, file: string, weight: number) => {
    const path = join(dir, file);
    return existsSync(path)
      ? `@font-face{font-family:'${family}';src:url(data:font/otf;base64,${readFileSync(path).toString('base64')}) format('opentype');font-weight:${weight};font-display:swap}`
      : '';
  };
  return face('Averox', 'averox.otf', 400) + face('Noah', 'noah-regular.otf', 400) + face('Noah', 'noah-bold.otf', 700);
}

// All the page styles, inline, so the HTML file needs nothing else (works offline and as an attachment).
const CSS = `
:root{color-scheme:dark;
  --bg:#030214;--bg-grad:linear-gradient(180deg,#030214 0%,#2e1246 100%);--card:#2e1246;--card-2:rgba(3,2,20,.35);
  --border:rgba(114,75,99,.55);--text:#fbf7df;--text2:#e4dfd9;--muted:#a48d84;--grid:rgba(164,141,132,.18);
  --accent:#4f829b;--accent-soft:rgba(79,130,155,.15);--s1:#3a9cc4;--s2:#d55181;--s3:#c98500;
  --font:'Noah',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;--display:'Averox','Noah',sans-serif;--mono:'JetBrains Mono','SF Mono','Fira Code',Consolas,monospace}
@media (prefers-color-scheme:light){:root{color-scheme:light;
  --bg:#fafaf6;--bg-grad:#fafaf6;--card:#ffffff;--card-2:#f5f2ec;--border:#e4dfd9;--text:#1a0a2e;--text2:#483638;--muted:#6b5651;--grid:#ece7e1;
  --accent:#2d5f78;--accent-soft:rgba(45,95,120,.1);--s1:#2a7fa8;--s2:#c2457a;--s3:#a86f00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);background-image:var(--bg-grad);background-attachment:fixed;color:var(--text2);font:16px/1.65 var(--font)}
main{max-width:1040px;margin:0 auto;padding:48px 20px 80px}
h1{font-family:var(--display);text-transform:lowercase;font-weight:400;font-size:44px;line-height:1.1;color:var(--text);margin:0 0 10px;letter-spacing:.01em}
h2{font-size:22px;font-weight:700;color:var(--text);margin:0 0 6px}
.lead{font-size:15px;color:var(--muted);margin:0 0 32px}
.muted{color:var(--muted)}.small{font-size:14px}
section.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px 30px;margin-top:28px}
.card-intro{margin:0 0 20px;color:var(--text2);max-width:70ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px 22px;display:flex;flex-direction:column;gap:6px}
.tile-name{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.tile-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.tile-row .lab{color:var(--muted);font-size:14px}
.num{font-variant-numeric:tabular-nums;color:var(--text)}.big{font-size:28px;font-weight:700}
.tile-note{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:13px;line-height:1.55;color:var(--muted)}
.tile-note b{color:var(--text2)}
.context{margin:18px 2px 0;font-size:14px;color:var(--muted)}
svg{width:100%;height:auto;display:block;margin:8px 0 4px}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--muted);stroke-width:1}
.tick{fill:var(--muted);font-size:13px;font-family:var(--font)}.axis-title{fill:var(--text2);font-size:14px;font-family:var(--font)}
.line{fill:none;stroke-width:2.5}.line.s1{stroke:var(--s1)}
.dot{stroke:var(--card);stroke-width:2}.dot.s1{fill:var(--s1)}.dot.s2{fill:var(--s2)}.dot.current{stroke:var(--text);stroke-width:2.5}
.hit{fill:transparent}.mark:hover .dot{stroke:var(--text)}.diag{stroke:var(--muted);stroke-dasharray:5 5}
.dlabel{fill:var(--text2);font-size:13px;font-family:var(--font)}
.bar{display:flex;gap:3px;height:36px;border-radius:6px;overflow:hidden}.seg{min-width:6px}
.seg.s1,.sw.s1{background:var(--s1)}.seg.s2,.sw.s2{background:var(--s2)}.seg.s3,.sw.s3{background:var(--s3)}
.legend{display:flex;flex-wrap:wrap;gap:12px 28px;margin-top:14px;font-size:14px;color:var(--text2)}
.legend b{color:var(--text)}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:400;font-size:12px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td{color:var(--text2)}td:first-child{color:var(--text)}
td.model{min-width:210px}.mname{display:block;color:var(--text);font-family:var(--mono);font-size:13px}.mrole{display:block;color:var(--muted);font-size:13px;margin-top:2px}tbody tr:hover td{background:var(--accent-soft)}
td.n,th.n{text-align:right;white-space:nowrap}
.scroll{overflow-x:auto;margin:0 -8px;padding:0 8px}
details{margin-top:22px;background:var(--card-2);border-radius:10px;padding:14px 18px}
summary{cursor:pointer;color:var(--text);font-weight:700;font-size:15px}
.explain{margin:12px 0 2px;padding-left:20px;color:var(--text2);font-size:14px}.explain li{margin:0 0 10px;line-height:1.6}.explain b{color:var(--text)}
.finding{margin:18px 0 0;padding:14px 18px;border-left:4px solid var(--accent);background:var(--accent-soft);border-radius:6px;color:var(--text2);font-size:15px;line-height:1.6}
.finding b{color:var(--text)}
code{font:13px var(--mono);color:var(--text)}
.pairs tr.pair-a td{border-bottom:none;padding-bottom:4px}.pairs tr.pair-b td{padding-top:4px}.pairs td b{color:var(--text)}
.delta{display:block;font-size:12px;color:var(--accent);font-weight:400}
a{color:var(--accent)}
`;

/**
 * The whole page, top to bottom: title, before/after tiles, LLM pairs, where decisions went,
 * threshold sweep, calibration, per-model table, and the prices used.
 * Sections with no data render a short "nothing yet" note instead of an empty chart.
 */
export function renderReport(opts: { title: string; subtitle: string; summary: Summary; models: ModelStats[]; act: number }): string {
  const s = opts.summary;
  // The price table at the bottom, straight from src/prices.ts, with each source.
  const prices = Object.entries(PRICES)
    .map(([m, p]) => `<tr><td>${m}</td><td>$${p.input}</td><td>$${p.output}</td><td class="muted">${esc(p.source)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>${faviconLink()}<style>${fontFaces()}${CSS}</style></head><body><main>
<h1>${esc(opts.title)}</h1><p class="lead">${esc(opts.subtitle)}</p>
${kpis(s)}
${pairsSection(s)}
<section class="card"><h2>Where the decisions went</h2><p class="card-intro">Who gave the final answer for each decision in route(task).</p>${splitBar(s.split, s.pathModels)}</section>
<section class="card"><h2>Threshold sweep</h2><p class="card-intro">Each dot is one confidence threshold: Jev answers alone when it is at least this sure, ${esc(s.sweepModel ?? 'the escalation model')} answers the rest.</p>${sweepChart(s.sweep, opts.act)}${sweepExplain(s.sweep, opts.act, s)}${sweepTable(s.sweep)}</section>
<section class="card"><h2>Calibration</h2><p class="card-intro">When a model says 0.8, is it right 80% of the time? Dots near the dashed line are well calibrated. Bigger dot = more answers.</p>${calibrationChart(s.calibrationJev, s.calibrationLlm, s.calibrationLlmModel)}${calibrationExplain(s.calibrationJev, s.calibrationLlm, s.calibrationLlmModel)}</section>
${opts.models.length ? `<section class="card"><h2>Per model</h2><p class="card-intro">Every model that answered, and in which role.</p><div class="scroll">${modelTable(opts.models)}</div></section>` : ''}
<section class="card"><h2>Prices used</h2><p class="card-intro">USD per 1M tokens, checked on ${PRICES_CHECKED_ON}. Reasoning tokens are billed as output.</p><div class="scroll"><table><thead><tr><th>model</th><th>input</th><th>output</th><th>source</th></tr></thead><tbody>${prices}</tbody></table></div></section>
</main></body></html>`;
}
