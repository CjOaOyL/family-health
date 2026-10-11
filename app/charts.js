// Inline SVG timeline for Compare. One series per vendor (fixed colours via CSS tokens),
// reference band, selective direct labels, crosshair tooltip, keyboard-focusable points.
// Follows the dataviz method: thin marks, 8px markers with a surface ring, hairline grid, text in text tokens.
import { el, svg, clear, fmtDate, fmtNum, vendorKey, parseLocalDate } from './ui.js';

const SHAPE = { labcorp: 'circle', quest: 'diamond', other: 'triangle' };
const DAY = 86400000;

function niceStep(range, n) {
  const raw = range / Math.max(1, n);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function yScale(values, n = 4) {
  let min = Math.min(...values), max = Math.max(...values);
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (max === min) { const p = Math.abs(max) * 0.1 || 1; min -= p; max += p; }
  const pad = (max - min) * 0.12;
  min -= pad; max += pad;
  if (min < 0 && Math.min(...values) >= 0) min = 0;
  const step = niceStep(max - min, n);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

function fmtTick(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (a >= 1e3) return `${(v / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function xTicks(t0, t1, count) {
  const span = t1 - t0;
  const ticks = [];
  const fmt = span > 540 * DAY
    ? (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : span > 60 * DAY
      ? (d) => d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
      : (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  for (let i = 0; i <= count; i++) {
    const t = t0 + (span * i) / count;
    ticks.push({ t, label: fmt(new Date(t)) });
  }
  return ticks;
}

function markerPath(shape, cx, cy, r) {
  if (shape === 'diamond') return `M${cx} ${cy - r - 1}L${cx + r + 1} ${cy}L${cx} ${cy + r + 1}L${cx - r - 1} ${cy}Z`;
  if (shape === 'triangle') return `M${cx} ${cy - r - 1}L${cx + r + 1} ${cy + r}L${cx - r - 1} ${cy + r}Z`;
  return null;
}

/**
 * renderTimeline(container, { series, band, unit, title }) → cleanup()
 * series: [{ key: vendor, label, points: [{ t(ms), date(iso), y, valueText, unit, flag, reportId, range }] }]
 * band:   { low, high, text, from } | null
 */
export function renderTimeline(container, { series = [], band = null, unit = '', title = '' } = {}) {
  let ro = null;
  const tip = el('div', { class: 'chart-tip', hidden: true });

  function draw() {
    clear(container);
    container.appendChild(tip);
    tip.hidden = true;
    const W = Math.max(280, Math.floor(container.clientWidth || 600));
    const H = W < 480 ? 240 : 300;
    const allPoints = series.flatMap((s) => s.points.map((p) => ({ ...p, series: s })));
    if (!allPoints.length) {
      container.appendChild(svg('svg', { viewBox: `0 0 ${W} 120`, width: W, height: 120, role: 'img', 'aria-label': 'No data' }, svg('text', { x: W / 2, y: 60, 'text-anchor': 'middle', class: 'empty-msg' }, 'No numeric values to plot')));
      return;
    }

    const yValues = allPoints.map((p) => p.y);
    if (band) { if (band.low != null) yValues.push(band.low); if (band.high != null) yValues.push(band.high); }
    const ys = yScale(yValues, H < 260 ? 3 : 4);
    const leftPad = 10 + 7 * Math.max(...ys.ticks.map((t) => fmtTick(t).length));
    const m = { top: 26, right: 18, bottom: 34, left: Math.max(36, leftPad) };
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;

    let t0 = Math.min(...allPoints.map((p) => p.t)), t1 = Math.max(...allPoints.map((p) => p.t));
    if (t1 === t0) { t0 -= 30 * DAY; t1 += 30 * DAY; }
    const tp = (t1 - t0) * 0.05; t0 -= tp; t1 += tp;
    const x = (t) => m.left + ((t - t0) / (t1 - t0)) * pw;
    const y = (v) => m.top + ph - ((v - ys.lo) / (ys.hi - ys.lo)) * ph;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${title} over time${unit ? ' in ' + unit : ''}` });

    // Reference band (behind everything).
    if (band && (band.low != null || band.high != null)) {
      const top = band.high != null ? y(band.high) : m.top;
      const bottom = band.low != null ? y(band.low) : m.top + ph;
      const g = svg('g', { class: 'band' },
        svg('rect', { x: m.left, y: Math.min(top, bottom), width: pw, height: Math.max(1, Math.abs(bottom - top)) }),
        svg('text', { x: m.left + 4, y: Math.min(top, bottom) + 11, 'text-anchor': 'start' }, `ref ${band.text || ''}`));
      root.appendChild(g);
    }

    // Grid + axes.
    const grid = svg('g', { class: 'grid' });
    const yAxis = svg('g', { class: 'axis' });
    for (const t of ys.ticks) {
      grid.appendChild(svg('line', { x1: m.left, x2: m.left + pw, y1: y(t), y2: y(t) }));
      yAxis.appendChild(svg('text', { x: m.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmtTick(t)));
    }
    root.append(grid, yAxis);
    const xAxis = svg('g', { class: 'axis' }, svg('line', { x1: m.left, x2: m.left + pw, y1: m.top + ph, y2: m.top + ph }));
    const tickCount = Math.max(2, Math.min(6, Math.floor(pw / 90)));
    for (const tk of xTicks(t0 + tp, t1 - tp, tickCount)) {
      xAxis.appendChild(svg('line', { x1: x(tk.t), x2: x(tk.t), y1: m.top + ph, y2: m.top + ph + 4 }));
      xAxis.appendChild(svg('text', { x: x(tk.t), y: m.top + ph + 17, 'text-anchor': 'middle' }, tk.label));
    }
    root.appendChild(xAxis);

    // Series: lines then marks (marks above all lines).
    const labelAll = allPoints.length <= 14;
    const labels = svg('g', { class: 'labels' });
    const placed = [];
    const marksLayer = svg('g');
    const hitsLayer = svg('g');
    series.forEach((s) => {
      const vk = vendorKey(s.key);
      const g = svg('g', { class: `series series-${vk}` });
      if (s.points.length > 1) {
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.y).toFixed(1)}`).join('');
        g.appendChild(svg('path', { class: 'line', d }));
      }
      const mg = svg('g', { class: `series series-${vk}` });
      const ymin = Math.min(...s.points.map((p) => p.y)), ymax = Math.max(...s.points.map((p) => p.y));
      s.points.forEach((p, i) => {
        const cx = x(p.t), cy = y(p.y);
        const path = markerPath(SHAPE[vk], cx, cy, 4);
        mg.appendChild(path ? svg('path', { class: 'mark', d: path }) : svg('circle', { class: 'mark', cx, cy, r: 4 }));
        const isKey = i === 0 || i === s.points.length - 1 || p.y === ymin || p.y === ymax;
        if (labelAll || isKey) {
          const text = p.valueText || fmtNum(p.y);
          let lx = cx, ly = cy - 10;
          const w = text.length * 6.5;
          const collides = (px, py) => placed.some((b) => Math.abs(b.x - px) < (b.w + w) / 2 + 4 && Math.abs(b.y - py) < 12);
          if (collides(lx, ly)) ly = cy + 18;
          if (collides(lx, ly)) ly = null;
          if (ly != null) {
            lx = Math.min(Math.max(lx, m.left + w / 2), m.left + pw - w / 2);
            labels.appendChild(svg('text', { x: lx, y: ly, 'text-anchor': 'middle' }, text));
            placed.push({ x: lx, y: ly, w });
          }
        }
        const hit = svg('circle', { class: 'hit', cx, cy, r: 14, tabindex: '0', role: 'img', 'aria-label': `${s.label}, ${fmtDate(p.date, { time: false })}: ${p.valueText || p.y} ${p.unit || ''}${p.flag ? ' flag ' + p.flag : ''}` });
        hit.addEventListener('focus', () => showTip(p.t, cx));
        hit.addEventListener('blur', hideTip);
        hit.addEventListener('pointerenter', () => showTip(p.t, cx));
        hitsLayer.appendChild(hit);
      });
      root.appendChild(g);
      marksLayer.appendChild(mg);
    });
    root.append(marksLayer, labels);

    // Crosshair + overlay.
    const cross = svg('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.top, y2: m.top + ph, visibility: 'hidden' });
    root.appendChild(cross);
    const overlay = svg('rect', { x: m.left, y: m.top, width: pw, height: ph, fill: 'transparent' });
    overlay.addEventListener('pointermove', (e) => {
      const r = root.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      let best = null, bd = Infinity;
      for (const p of allPoints) { const d = Math.abs(x(p.t) - px); if (d < bd) { bd = d; best = p; } }
      if (best) showTip(best.t, x(best.t));
    });
    overlay.addEventListener('pointerleave', hideTip);
    root.appendChild(overlay);
    root.appendChild(hitsLayer);
    container.appendChild(root);

    // Legend: only for 2+ series; band legend when present.
    if (series.length >= 2 || band) {
      const legend = el('div', { class: 'legend' });
      if (series.length >= 2) for (const s of series) legend.appendChild(el('span', { class: 'item' }, el('span', { class: `key ${vendorKey(s.key)}` }), `${s.label} (${SHAPE[vendorKey(s.key)]})`));
      if (band) legend.appendChild(el('span', { class: 'item' }, el('span', { class: 'swatch-band' }), `Reference ${band.text || ''}${band.from ? ' · from ' + band.from : ''}`));
      container.appendChild(legend);
    }

    function showTip(t, px) {
      const near = allPoints.filter((p) => Math.abs(p.t - t) < DAY).sort((a, b) => a.series.label.localeCompare(b.series.label));
      if (!near.length) return hideTip();
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      clear(tip);
      tip.appendChild(el('div', { class: 'd' }, fmtDate(near[0].date, { time: false })));
      for (const p of near) {
        tip.appendChild(el('div', { class: 'r' },
          el('span', { class: `key ${vendorKey(p.series.key)}` }),
          el('span', { class: 'val' }, `${p.valueText || fmtNum(p.y)}${p.unit ? ' ' + p.unit : ''}`),
          p.flag ? el('span', { class: `chip chip-flag-${p.flag}` }, p.flag) : null,
          el('span', { class: 'lab' }, p.series.label)));
      }
      if (near[0].range) tip.appendChild(el('div', { class: 'd' }, `ref ${near[0].range}`));
      tip.hidden = false;
      const r = root.getBoundingClientRect();
      const scale = r.width / W;
      const left = px * scale;
      const tw = tip.offsetWidth || 160;
      tip.style.top = `${Math.max(0, m.top * scale)}px`;
      tip.style.left = left + 14 + tw > r.width ? `${Math.max(0, left - 14 - tw)}px` : `${left + 14}px`;
    }
    function hideTip() { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); }
  }

  draw();
  if (typeof ResizeObserver !== 'undefined') {
    let last = container.clientWidth;
    ro = new ResizeObserver(() => { const w = container.clientWidth; if (Math.abs(w - last) > 8) { last = w; draw(); } });
    ro.observe(container);
  }
  return () => { if (ro) ro.disconnect(); clear(container); };
}

export { parseLocalDate };
