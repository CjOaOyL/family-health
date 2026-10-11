// Results view: all results for a member across reports, with filters, sort, CSV export.
import { el, clear, button, chip, select, field, fmtDate, fmtShortDate, flagChip, vendorChip, vendorLabel, table, download, toCSV, emptyState, toast } from '../ui.js';
import { hashFor, navigate } from '../state.js';
import { flattenResults, analyteOptions } from '../reportUtil.js';
import { analyteNames } from '../pipeline.js';
import { listMembers, listReports } from '../../src/store/db.js';

export const title = 'Results';

export async function render(root, { query }) {
  const members = await listMembers();
  const names = await analyteNames();
  const state = {
    memberId: query.member || members[0]?.id || '',
    analyte: query.analyte || '',
    vendor: query.vendor || '',
    from: query.from || '',
    to: query.to || '',
    sortDesc: query.sort !== 'asc',
  };

  const page = el('div');
  root.appendChild(page);
  await draw();

  async function draw() {
    clear(page);
    page.appendChild(el('div', { class: 'page-title' }, el('h1', 'Results')));
    if (!members.length) { page.appendChild(emptyState('No family members yet. Import a report first.', el('a', { class: 'btn', href: '#/import' }, 'Import a PDF'))); return; }

    const records = state.memberId ? await listReports(state.memberId) : [];
    const all = flattenResults(records, names);
    const analytes = analyteOptions(all);
    const vendors = Array.from(new Set(all.map((r) => r.vendor)));

    const memberSel = select({ options: members.map((m) => ({ value: m.id, label: m.name })), value: state.memberId, onChange: (v) => { state.memberId = v; state.analyte = ''; sync(); } });
    const analyteSel = select({ placeholder: 'All analytes', options: analytes.map((a) => ({ value: a.key, label: `${a.display} (${a.count})` })), value: state.analyte, onChange: (v) => { state.analyte = v; sync(); } });
    const vendorSel = select({ placeholder: 'All vendors', options: vendors.map((v) => ({ value: v, label: vendorLabel(v) })), value: state.vendor, onChange: (v) => { state.vendor = v; sync(); } });
    const from = el('input', { type: 'date', value: state.from, onChange: (e) => { state.from = e.target.value; sync(); } });
    const to = el('input', { type: 'date', value: state.to, onChange: (e) => { state.to = e.target.value; sync(); } });

    page.appendChild(el('div', { class: 'filters' },
      field('Member', memberSel), field('Analyte', analyteSel), field('Vendor', vendorSel), field('From', from), field('To', to)));

    const rows = all.filter((r) =>
      (!state.analyte || r.key === state.analyte) &&
      (!state.vendor || r.vendor === state.vendor) &&
      (!state.from || (r.date && r.date.slice(0, 10) >= state.from)) &&
      (!state.to || (r.date && r.date.slice(0, 10) <= state.to)));
    rows.sort((a, b) => {
      const da = a.date || '', db = b.date || '';
      if (da !== db) return state.sortDesc ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
      return (a.display || '').localeCompare(b.display || '');
    });

    const toolbar = el('div', { class: 'toolbar', style: { marginBottom: '10px' } },
      chip(`${rows.length} of ${all.length} results`, 'muted'),
      chip(`${records.length} report${records.length === 1 ? '' : 's'}`, 'muted'),
      el('span', { class: 'spacer' }),
      button(state.sortDesc ? 'Date ↓' : 'Date ↑', () => { state.sortDesc = !state.sortDesc; sync(); }, { small: true, title: 'Toggle sort order' }),
      state.analyte ? button('Compare', () => navigate(hashFor('compare', null, { member: state.memberId, analyte: state.analyte })), { small: true }) : null,
      button('Export CSV', () => exportCsv(rows), { small: true, disabled: !rows.length }));
    page.appendChild(toolbar);

    if (!records.length) { page.appendChild(emptyState('No reports for this member yet.')); return; }
    if (!rows.length) { page.appendChild(emptyState('No results match these filters.')); return; }

    page.appendChild(table({
      head: ['Date', 'Vendor', 'Panel', 'Test', 'Value', 'Unit', 'Flag', 'Reference', ''],
      numeric: [4],
      rows: rows.map((r) => ({
        class: r.flag ? 'flagged' : null,
        cells: [
          el('span', { class: 'nowrap', title: fmtDate(r.date) }, fmtShortDate(r.date) || '—'),
          vendorChip(r.vendor),
          el('span', { class: 'small text-2' }, r.panel || ''),
          el('span', r.display, r.display !== r.name ? el('span', { class: 'sub' }, r.name) : null),
          el('span', { class: 'num' }, r.valueText ?? ''),
          r.unit || '',
          flagChip(r.flag),
          el('span', { class: 'small' }, r.rangeText || ''),
          el('a', { class: 'small', href: hashFor('review', r.reportId), title: 'Open report' }, 'report'),
        ],
      })),
    }));
  }

  function sync() {
    const member = members.find((m) => m.id === state.memberId);
    history.replaceState(null, '', hashFor('results', null, { member: state.memberId, analyte: state.analyte, vendor: state.vendor, from: state.from, to: state.to, sort: state.sortDesc ? '' : 'asc' }));
    document.title = `Results${member ? ' · ' + member.name : ''} · Family Health`;
    draw();
  }

  function exportCsv(rows) {
    const member = members.find((m) => m.id === state.memberId);
    const data = [['Date', 'Vendor', 'Panel', 'Test', 'Canonical ID', 'Value', 'Numeric', 'Unit', 'Flag', 'Reference', 'Low', 'High', 'Confidence', 'Report']];
    for (const r of rows) data.push([r.date || '', vendorLabel(r.vendor), r.panel || '', r.name, r.canonicalId || '', r.valueText ?? '', r.value ?? '', r.unit || '', r.flag || '', r.rangeText || '', r.range?.low ?? '', r.range?.high ?? '', r.confidence ?? '', r.reportId]);
    const safe = (member?.name || 'member').replace(/[^\w-]+/g, '_');
    download(`results-${safe}-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(data), 'text/csv');
    toast('CSV downloaded');
  }
}
