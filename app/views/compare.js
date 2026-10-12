// Compare view: (1) member + analyte timeline across vendors; (2) two reports side by side.
import { el, clear, button, chip, select, field, fmtDate, fmtShortDate, fmtNum, flagChip, vendorChip, vendorLabel, table, emptyState, notice, parseLocalDate } from '../ui.js';
import { hashFor } from '../state.js';
import { flattenResults, analyteOptions, effectiveReport, analyteKey, rangeText, humanizeId } from '../reportUtil.js';
import { analyteNames } from '../pipeline.js';
import { listMembers, listReports } from '../../src/store/db.js';
import { renderTimeline } from '../charts.js';

export const title = 'Compare';

export async function render(root, { query }) {
  const members = await listMembers();
  const names = await analyteNames();
  const state = {
    mode: query.mode === 'reports' ? 'reports' : 'timeline',
    memberId: query.member || members[0]?.id || '',
    analyte: query.analyte || '',
    a: query.a || '',
    b: query.b || '',
  };
  let chartCleanup = null;
  const page = el('div');
  root.appendChild(page);
  await draw();

  async function draw() {
    if (chartCleanup) { chartCleanup(); chartCleanup = null; }
    clear(page);
    page.appendChild(el('div', { class: 'page-title' }, el('h1', 'Compare')));
    if (!members.length) { page.appendChild(emptyState('No family members yet. Import a report first.', el('a', { class: 'btn', href: '#/import' }, 'Import a PDF'))); return; }

    const tabs = el('div', { class: 'tabs' },
      el('button', { type: 'button', class: state.mode === 'timeline' ? 'active' : null, onClick: () => { state.mode = 'timeline'; sync(); } }, 'Timeline'),
      el('button', { type: 'button', class: state.mode === 'reports' ? 'active' : null, onClick: () => { state.mode = 'reports'; sync(); } }, 'Two reports'));
    page.appendChild(tabs);

    const records = state.memberId ? await listReports(state.memberId) : [];
    const memberSel = select({ options: members.map((m) => ({ value: m.id, label: m.name })), value: state.memberId, onChange: (v) => { state.memberId = v; state.analyte = ''; state.a = ''; state.b = ''; sync(); } });

    if (state.mode === 'timeline') await timeline(records, memberSel);
    else twoReports(records, memberSel);
  }

  // ---------- timeline ----------
  async function timeline(records, memberSel) {
    const all = flattenResults(records, names);
    const analytes = analyteOptions(all);
    if (!state.analyte && analytes.length) state.analyte = analytes[0].key;
    const analyteSel = select({ placeholder: analytes.length ? '— analyte —' : 'No results', options: analytes.map((a) => ({ value: a.key, label: `${a.display} (${a.count})` })), value: state.analyte, onChange: (v) => { state.analyte = v; sync(); } });
    page.appendChild(el('div', { class: 'filters' }, field('Member', memberSel), field('Analyte', analyteSel)));

    const rows = all.filter((r) => r.key === state.analyte && r.date && parseLocalDate(r.date));
    if (!records.length) { page.appendChild(emptyState('No reports for this member yet.')); return; }
    if (!rows.length) { page.appendChild(emptyState('No dated results for this analyte.')); return; }

    const display = rows[0].display;
    const numeric = rows.filter((r) => (r.canonicalValue ?? r.value) != null);
    const textOnly = rows.filter((r) => (r.canonicalValue ?? r.value) == null);
    const units = Array.from(new Set(numeric.map((r) => r.canonicalUnit || r.unit).filter(Boolean)));
    const unit = units[0] || '';

    // Series per vendor, sorted by time.
    const seriesMap = new Map();
    for (const r of numeric) {
      const k = r.vendor;
      if (!seriesMap.has(k)) seriesMap.set(k, { key: k, label: vendorLabel(k), points: [] });
      const y = r.canonicalValue ?? r.value;
      // Labels and tooltips must be in the plotted (canonical) unit: a printed "68 cells/uL" plots at 0.068.
      const converted = r.canonicalValue != null && r.value != null && r.canonicalValue !== r.value;
      seriesMap.get(k).points.push({
        t: parseLocalDate(r.date).getTime(), date: r.date, y, valueText: converted ? fmtNum(y) : r.valueText,
        unit: r.canonicalUnit || r.unit || '', printed: converted ? `${r.valueText} ${r.unit || ''}`.trim() : null,
        flag: r.flag, reportId: r.reportId, range: r.rangeText ? `${r.rangeText}${r.unit ? ' ' + r.unit : ''}` : '',
      });
    }
    const series = Array.from(seriesMap.values()).map((s) => ({ ...s, points: s.points.sort((a, b) => a.t - b.t) }));

    // Reference band from the most recent result with numeric bounds. Its low/high are printed in that
    // result's own unit, while points are plotted in the canonical unit: scale the band by the same factor
    // that result's value was converted with, or skip it when no factor can be derived.
    const latest = numeric.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).find((r) => r.range && (r.range.low != null || r.range.high != null));
    let band = null;
    let bandNote = null;
    if (latest) {
      const plotUnit = latest.canonicalUnit || latest.unit || '';
      const printedUnit = latest.unit || '';
      const sameUnit = !latest.canonicalUnit || !latest.unit || normUnit(latest.canonicalUnit) === normUnit(latest.unit) || latest.canonicalValue == null || latest.canonicalValue === latest.value;
      let factor = 1;
      if (!sameUnit) {
        factor = typeof latest.value === 'number' && latest.value !== 0 && typeof latest.canonicalValue === 'number' ? latest.canonicalValue / latest.value : NaN;
      }
      if (isFinite(factor) && factor > 0) {
        const lo = latest.range.low != null ? +(latest.range.low * factor).toPrecision(6) : null;
        const hi = latest.range.high != null ? +(latest.range.high * factor).toPrecision(6) : null;
        const text = factor === 1 ? latest.rangeText : (lo != null && hi != null ? `${fmtNum(lo)}–${fmtNum(hi)}` : lo != null ? `≥${fmtNum(lo)}` : `≤${fmtNum(hi)}`);
        band = { low: lo, high: hi, text, unit: plotUnit, from: fmtShortDate(latest.date) };
        if (factor !== 1) bandNote = notice(`Reference range ${latest.rangeText} ${printedUnit} converted to ${plotUnit} for the chart.`);
      } else {
        bandNote = notice(`Reference range ${latest.rangeText} ${printedUnit} is not drawn: it is printed in a different unit than the plotted values (${plotUnit}) and cannot be converted.`, 'warn');
      }
    }

    const card = el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', display), chip(`${numeric.length} value${numeric.length === 1 ? '' : 's'}`, 'muted'), unit ? chip(unit, 'muted') : null),
      units.length > 1 ? notice(`Mixed units across reports (${units.join(', ')}); values are plotted as stored without conversion.`, 'warn') : null,
      bandNote);
    const chartHost = el('div', { class: 'chart' });
    card.appendChild(chartHost);
    page.appendChild(card);
    chartCleanup = renderTimeline(chartHost, { series, band, unit, title: display });

    // Table view (always available: the chart never gates the data).
    const sorted = rows.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    page.appendChild(el('section', { class: 'card' }, el('h3', 'Values'), table({
      head: ['Date', 'Vendor', 'Value', 'Unit', 'Flag', 'Reference', ''],
      numeric: [2],
      rows: sorted.map((r) => [
        el('span', { class: 'nowrap' }, fmtShortDate(r.date)), vendorChip(r.vendor), el('span', { class: 'num' }, r.valueText ?? ''), r.unit || '', flagChip(r.flag), el('span', { class: 'small' }, r.rangeText || ''),
        el('a', { class: 'small', href: hashFor('review', r.reportId) }, 'report'),
      ]),
    })));
    if (textOnly.length) page.appendChild(notice(`${textOnly.length} non-numeric result${textOnly.length === 1 ? '' : 's'} (e.g. text values) listed in the table but not plotted.`));
  }

  // ---------- two reports ----------
  function twoReports(records, memberSel) {
    const opts = records.map((r) => ({ value: r.id, label: `${fmtDate(r.report?.specimen?.collectedAt, { time: false }) || 'no date'} · ${vendorLabel(r.report?.source?.vendor)} · ${(r.report?.results || []).length} results` }));
    if (!state.a && records[0]) state.a = records[0].id;
    if (!state.b && records[1]) state.b = records[1].id;
    const selA = select({ placeholder: '— report A —', options: opts, value: state.a, onChange: (v) => { state.a = v; sync(); } });
    const selB = select({ placeholder: '— report B —', options: opts, value: state.b, onChange: (v) => { state.b = v; sync(); } });
    page.appendChild(el('div', { class: 'filters' }, field('Member', memberSel), field('Report A', selA), field('Report B', selB)));
    if (records.length < 2) { page.appendChild(emptyState('Need at least two reports for this member.')); return; }
    const ra = records.find((r) => r.id === state.a);
    const rb = records.find((r) => r.id === state.b);
    if (!ra || !rb) { page.appendChild(emptyState('Pick two reports.')); return; }
    if (ra.id === rb.id) { page.appendChild(notice('Pick two different reports.', 'warn')); return; }
    const A = effectiveReport(ra), B = effectiveReport(rb);

    const joined = new Map();
    const add = (rep, side) => {
      for (const r of rep.results || []) {
        const k = analyteKey(r);
        if (!joined.has(k)) joined.set(k, { key: k, display: (r.canonicalId && names.get(r.canonicalId)?.display) || humanizeId(r.canonicalId) || r.name, a: null, b: null });
        const j = joined.get(k);
        if (!j[side]) j[side] = r;
      }
    };
    add(A, 'a'); add(B, 'b');
    const list = Array.from(joined.values()).sort((x, y) => {
      const bothX = x.a && x.b ? 0 : 1, bothY = y.a && y.b ? 0 : 1;
      return bothX - bothY || x.display.localeCompare(y.display);
    });
    const both = list.filter((j) => j.a && j.b).length;

    const head = (rep, label) => el('span', label, el('span', { class: 'sub' }, `${fmtDate(rep.specimen?.collectedAt, { time: false }) || '—'} · ${vendorLabel(rep.source?.vendor)}`));
    const cell = (r) => r ? el('span', el('span', { class: 'num' }, r.valueText ?? ''), r.unit ? ` ${r.unit}` : '', ' ', flagChip(r.flag), el('span', { class: 'sub' }, rangeText(r.referenceRange))) : el('span', { class: 'muted' }, '—');
    // Δ is computed in the shared canonical unit (when both sides have one), else in the printed unit when
    // the two printed units agree. The unit is always shown, and when the printed units differ both values
    // are shown converted so "+0.032" never sits unlabeled next to "68 cells/uL vs 0.1 x10E3/uL".
    const delta = (j) => {
      if (!j.a || !j.b) return '';
      const canon = j.a.canonicalUnit && j.a.canonicalUnit === j.b.canonicalUnit ? j.a.canonicalUnit : null;
      const printedSame = normUnit(j.a.unit) === normUnit(j.b.unit);
      const unit = canon || (printedSame ? (j.a.unit || '') : null);
      const va = canon ? j.a.canonicalValue : j.a.value;
      const vb = canon ? j.b.canonicalValue : j.b.value;
      if (va == null || vb == null) return el('span', { class: 'muted' }, j.a.valueText === j.b.valueText ? 'same' : 'differs');
      if (unit == null) return el('span', { class: 'muted', title: 'Printed units differ and no shared canonical unit is known' }, `units differ (${j.a.unit || '?'} vs ${j.b.unit || '?'})`);
      const d = vb - va;
      const p = va !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / Math.abs(va)) * 100)}%)` : '';
      const converted = canon && (!printedSame || normUnit(j.a.unit) !== normUnit(canon));
      return el('span', { class: 'num' }, `${d > 0 ? '+' : ''}${fmtNum(d)}${unit ? ' ' + unit : ''}${p}`,
        converted ? el('span', { class: 'sub' }, `${fmtNum(va)} → ${fmtNum(vb)} ${unit}`) : null);
    };

    page.appendChild(el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', 'Side by side'), chip(`${both} shared`, 'muted'), chip(`${list.length - both} only in one`, 'muted')),
      table({
        head: ['Test', head(A, 'A'), head(B, 'B'), 'Δ (B − A)'],
        numeric: [3],
        rows: list.map((j) => [el('span', j.display, j.a?.panel || j.b?.panel ? el('span', { class: 'sub' }, j.a?.panel || j.b?.panel) : null), cell(j.a), cell(j.b), delta(j)]),
      }),
      el('p', { class: 'muted small' }, 'Rows are joined on the analyte dictionary id, falling back to the printed test name. Δ is in the unit shown; when the two reports print different units both values are converted to that unit.')));
  }

  function normUnit(u) { return String(u || '').toLowerCase().replace(/\s+/g, '').replace(/x10e/g, '10^').replace(/µ/g, 'u'); }

  function sync() {
    history.replaceState(null, '', hashFor('compare', null, { mode: state.mode === 'reports' ? 'reports' : '', member: state.memberId, analyte: state.mode === 'timeline' ? state.analyte : '', a: state.mode === 'reports' ? state.a : '', b: state.mode === 'reports' ? state.b : '' }));
    draw();
  }

  return () => { if (chartCleanup) chartCleanup(); };
}
