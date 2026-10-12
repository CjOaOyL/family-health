// Adversarial synthetic PDF generator (pdf-lib) for test/robustness.test.js.
// A more configurable cousin of fixtures/gen/build.js: every geometry choice that the stock generator hard-codes
// (column x, font size, value alignment, flag placement, header label layout, page markers, table header) is an
// option here, so the parsers can be exercised on inputs their authors never saw.
// Every person, provider, NPI, address and phone number here is fake.
//
//   import { buildVariant, expectedRows, diffRows, L, Q, M, PAGE_BREAK, FOOTER_ONLY } from './gen.js'
//   const { bytes, pageCount } = await buildVariant(spec, opts)
//
// Row helpers carry explicit expectations so the diff never has to guess:
//   L(name, value, flag, unit, ref, lab, opts)          Labcorp (classic + portal)
//   Q(name, value, flag, ref, unit, lab, opts)          Quest classic: printed reference cell is `${ref} ${unit}`
//   M(name, value, unit, ref, flag, opts)               MyQuest: printed value `${value} ${unit}`, ref `${ref} ${unit}`
//   opts: { notes: [], cont: 'wrapped second line of the name', expectValue: number|null }

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { normalizeFlag } from '../../src/parse/common.js';

export const PAGE = { width: 612, height: 792 };

export const BASE_COLUMNS = {
  labcorp: { name: 36, value: 250, flag: 330, unit: 380, ref: 450, lab: 560 },
  quest: { name: 36, inRange: 260, outOfRange: 330, ref: 410, lab: 560 },
  myquest: { name: 36, value: 260, ref: 380, flag: 540 },
};

export const BASE_LAYOUT = {
  'labcorp-classic': { bodyTop: 262, bodyBottom: 690, lineHeight: 11, fontSize: 8, noteIndent: 10, cols: 'labcorp' },
  'labcorp-portal': { bodyTop: 190, bodyBottom: 690, lineHeight: 11, fontSize: 8, noteIndent: 10, cols: 'labcorp' },
  'quest-classic': { bodyTop: 190, bodyBottom: 680, lineHeight: 11, fontSize: 8, noteIndent: 10, cols: 'quest' },
  'quest-myquest': { bodyTop: 150, bodyBottom: 700, lineHeight: 12, fontSize: 9, noteIndent: 10, cols: 'myquest' },
};

export const L = (name, value, flag, unit, ref, lab = '01', opts = {}) => ({ kind: 'L', name, value, flag, unit, ref, lab, ...opts });
export const Q = (name, value, flag, ref, unit, lab = 'EZ', opts = {}) => ({ kind: 'Q', name, value, flag, ref, unit, lab, ...opts });
export const M = (name, value, unit, ref, flag = '', opts = {}) => ({ kind: 'M', name, value, unit, ref, flag, ...opts });
export const PAGE_BREAK = { pageBreak: true };
export const FOOTER_ONLY = { footerOnly: true };

export function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------------------------------------
// Expectations + diff
// ---------------------------------------------------------------------------------------------
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normText = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());

function numericOf(valueText) {
  const m = String(valueText).trim().match(/^([<>]=?)?\s*([-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d*\.?\d+)$/);
  return m ? parseFloat(m[2].replace(/,/g, '')) : null;
}

/** Flat list of what the generator printed, in document order, with the fields a parser should recover. */
export function expectedRows(spec) {
  const out = [];
  for (const panel of spec.panels) {
    if (!panel.rows) continue;
    for (const r of panel.rows) {
      const name = r.cont ? `${r.name} ${r.cont}` : r.name;
      const flag = r.flag ? normalizeFlag(r.flag) : null;
      out.push({
        name, panel: panel.name,
        valueText: 'expectValueText' in r ? r.expectValueText : r.value,
        value: 'expectValue' in r ? r.expectValue : numericOf(r.value),
        flag: 'expectFlag' in r ? r.expectFlag : flag,
        unit: 'expectUnit' in r ? r.expectUnit : (r.unit || null),
        rangeText: 'expectRange' in r ? r.expectRange : (r.ref || null),
        lab: r.lab ?? null,
      });
    }
  }
  return out;
}

/**
 * diffRows(expected, report) → { missing: string[], mismatches: [{name, field, expected, got}], extra: string[], matched: number }
 * Matches by normalized name in document order (duplicates are consumed first-come).
 */
export function diffRows(expected, report, { fields = ['valueText', 'value', 'flag', 'unit', 'rangeText'] } = {}) {
  const queues = new Map();
  for (const r of report.results || []) {
    const k = normName(r.name);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(r);
  }
  const missing = [], mismatches = [];
  let matched = 0;
  for (const e of expected) {
    const q = queues.get(normName(e.name));
    const got = q && q.length ? q.shift() : null;
    if (!got) { missing.push(e.name); continue; }
    matched++;
    const actual = {
      valueText: normText(got.valueText), value: got.value, flag: got.flag, unit: normText(got.unit),
      rangeText: normText(got.referenceRange && got.referenceRange.text), lab: got.performingLabCode,
    };
    for (const f of fields) {
      let exp = e[f], act = actual[f];
      if (f === 'valueText' || f === 'rangeText' || f === 'unit') { exp = normText(exp); act = normText(act); }
      // A directionless Critical ('C') resolves to HH/LL in index.js; accept either.
      if (f === 'flag' && exp === 'C' && (act === 'HH' || act === 'LL' || act === 'C')) continue;
      if (f === 'rangeText' && !exp && !act) continue;
      if (exp !== act && !(exp == null && act == null)) mismatches.push({ name: e.name, field: f, expected: exp, got: act });
    }
  }
  const extra = [];
  for (const [, q] of queues) for (const r of q) extra.push(r.name);
  return { missing, mismatches, extra, matched };
}

// ---------------------------------------------------------------------------------------------
// Flow + pagination
// ---------------------------------------------------------------------------------------------
function flowItems(spec) {
  const items = [];
  for (const panel of spec.panels) {
    if (panel.pageBreak) { items.push({ kind: 'pageBreak' }); continue; }
    if (panel.footerOnly) { items.push({ kind: 'footerOnly' }); continue; }
    items.push({ kind: 'panel', name: panel.name });
    for (const row of panel.rows) {
      items.push({ kind: 'row', row });
      if (row.cont) items.push({ kind: 'cont', text: row.cont });
      for (const note of row.notes || []) items.push({ kind: 'note', text: note });
    }
    items.push({ kind: 'blank' });
  }
  return items;
}

function paginate(items, layout) {
  const perPage = Math.floor((layout.bodyBottom - layout.bodyTop) / layout.lineHeight);
  const pages = [{ items: [], footerOnly: false }];
  for (const it of items) {
    let cur = pages[pages.length - 1];
    if (it.kind === 'pageBreak') { if (cur.items.length || cur.footerOnly) pages.push({ items: [], footerOnly: false }); continue; }
    if (it.kind === 'footerOnly') {
      if (cur.items.length) { pages.push({ items: [], footerOnly: true }); } else cur.footerOnly = true;
      pages.push({ items: [], footerOnly: false });
      continue;
    }
    if (it.kind === 'blank' && cur.items.length === 0) continue;
    if (cur.items.length >= perPage) { pages.push({ items: [], footerOnly: false }); cur = pages[pages.length - 1]; if (it.kind === 'blank') continue; }
    cur.items.push(it);
  }
  for (const p of pages) while (p.items.length && p.items[p.items.length - 1].kind === 'blank') p.items.pop();
  while (pages.length > 1 && !pages[pages.length - 1].items.length && !pages[pages.length - 1].footerOnly) pages.pop();
  return pages;
}

// ---------------------------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------------------------
class Canvas {
  constructor(page, fonts, fontSize) { this.page = page; this.fonts = fonts; this.fontSize = fontSize; }
  text(x, yTop, str, { bold = false, size = this.fontSize } = {}) {
    if (str === undefined || str === null || String(str).trim() === '') return;
    const font = bold ? this.fonts.bold : this.fonts.regular;
    this.page.drawText(String(str), { x, y: PAGE.height - yTop, size, font, color: rgb(0, 0, 0) });
  }
  /** Right-aligned text whose right edge sits at x. */
  textR(xRight, yTop, str, o = {}) {
    if (str === undefined || str === null || String(str).trim() === '') return;
    this.text(xRight - this.width(str, o), yTop, str, o);
  }
  width(str, { bold = false, size = this.fontSize } = {}) {
    return (bold ? this.fonts.bold : this.fonts.regular).widthOfTextAtSize(String(str), size);
  }
  rule(yTop, x0 = 36, x1 = PAGE.width - 36) {
    this.page.drawLine({ start: { x: x0, y: PAGE.height - yTop }, end: { x: x1, y: PAGE.height - yTop }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
  }
}

/** Legend lines use two-space separators; draw each segment as its own item so columns are gaps, not spaces. */
function drawLegend(c, x, y, line, size) {
  let cx = x;
  for (const seg of line.split('  ')) { c.text(cx, y, seg, { size }); cx += c.width(seg, { size }) + 14; }
}

/** Draw "Label: value" pairs in a column, honoring the header options. Returns the next y. */
function drawLabelColumn(c, x, y0, pitch, pairs, hdr, size) {
  let y = y0;
  for (const p of pairs) {
    if (p.raw) { c.text(x, y, p.raw, { size }); y += pitch; continue; }
    const below = hdr.valueBelow && hdr.valueBelow.includes(p.key);
    if (below) { c.text(x, y, `${p.label}:`, { size }); y += pitch; c.text(x, y, p.value, { size }); y += pitch; continue; }
    c.text(x, y, `${p.label}: ${p.value ?? ''}`.replace(/\s+$/, ''), { size });
    y += pitch;
  }
  return y;
}

// ---------------------------------------------------------------------------------------------
// Row drawing (shared knobs)
// ---------------------------------------------------------------------------------------------
function drawValue(c, x, y, value, o, size) {
  if (o.rightAlign) c.textR(o.rightAlign, y, value, { size });
  else c.text(x, y, value, { size });
}
function valueLeftX(c, x, value, o, size) {
  return o.rightAlign ? o.rightAlign - c.width(value, { size }) : x;
}

function labcorpBodyLine(c, y, it, layout, cols, o) {
  const size = o.fontSize || layout.fontSize;
  switch (it.kind) {
    case 'panel': c.text(cols.name, y, it.name, { bold: true, size }); break;
    case 'row': {
      const r = it.row;
      c.text(cols.name, y, r.name, { size });
      const mode = o.flagMode || 'cols';
      if (mode === 'inline' && r.flag) {
        drawValue(c, cols.value, y, `${r.value} ${r.flag}`, o, size);
      } else if (mode === 'gap2' && r.flag) {
        drawValue(c, cols.value, y, r.value, o, size);
        const vx = valueLeftX(c, cols.value, r.value, o, size);
        c.text(vx + c.width(r.value, { size }) + 2, y, r.flag, { size });
      } else {
        drawValue(c, cols.value, y, r.value, o, size);
        c.text(cols.flag, y, r.flag, { size });
      }
      c.text(cols.unit, y, r.unit, { size });
      c.text(cols.ref, y, r.ref, { size });
      c.text(cols.lab, y, r.lab, { size });
      break;
    }
    case 'cont': c.text(cols.name, y, it.text, { size }); break;
    case 'note': c.text(cols.name + layout.noteIndent, y, it.text, { size }); break;
    default: break;
  }
}

function questBodyLine(c, y, it, layout, cols, o) {
  const size = o.fontSize || layout.fontSize;
  switch (it.kind) {
    case 'panel': c.text(cols.name, y, it.name, { bold: true, size }); break;
    case 'row': {
      const r = it.row;
      c.text(cols.name, y, r.name, { size });
      const refCell = o.questUnitsInValueCell ? r.ref : [r.ref, r.unit].filter(Boolean).join(' ');
      const valueCell = o.questUnitsInValueCell && r.unit ? `${r.value} ${r.unit}` : r.value;
      const gap = o.questFlagGap ?? 3;
      if (r.flag) {
        const mode = o.flagMode || 'gap';
        if (mode === 'inline') drawValue(c, cols.outOfRange, y, `${valueCell} ${r.flag}`, o, size);
        else {
          drawValue(c, cols.outOfRange, y, valueCell, o, size);
          const vx = valueLeftX(c, cols.outOfRange, valueCell, o, size);
          c.text(vx + c.width(valueCell, { size }) + gap, y, r.flag, { size });
        }
      } else {
        drawValue(c, cols.inRange, y, valueCell, o, size);
      }
      c.text(cols.ref, y, refCell, { size });
      c.text(cols.lab, y, r.lab, { size });
      break;
    }
    case 'cont': c.text(cols.name, y, it.text, { size }); break;
    case 'note': c.text(cols.name + layout.noteIndent, y, it.text, { size }); break;
    default: break;
  }
}

function myQuestBodyLine(c, y, it, layout, cols, o) {
  const size = o.fontSize || layout.fontSize;
  switch (it.kind) {
    case 'panel': c.text(cols.name, y, it.name, { bold: true, size }); break;
    case 'row': {
      const r = it.row;
      c.text(cols.name, y, r.name, { size });
      const valueCell = [r.value, r.unit].filter(Boolean).join(' ');
      const refCell = [r.ref, r.unit].filter(Boolean).join(' ');
      const mode = o.flagMode || 'cols';
      if (mode === 'inline' && r.flag) drawValue(c, cols.value, y, `${valueCell} ${r.flag}`, o, size);
      else if (mode === 'gap2' && r.flag) {
        drawValue(c, cols.value, y, valueCell, o, size);
        const vx = valueLeftX(c, cols.value, valueCell, o, size);
        c.text(vx + c.width(valueCell, { size }) + 2, y, r.flag, { size, bold: true });
      } else {
        drawValue(c, cols.value, y, valueCell, o, size);
        c.text(cols.flag, y, r.flag, { bold: true, size });
      }
      c.text(cols.ref, y, refCell, { size });
      break;
    }
    case 'cont': c.text(cols.name, y, it.text, { size }); break;
    case 'note': c.text(cols.name + layout.noteIndent, y, it.text, { size }); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Headers / footers
// ---------------------------------------------------------------------------------------------
function tableHeader(c, y, pairs, size = 8) {
  for (const [x, t] of pairs) c.text(x, y, t, { bold: true, size });
  c.rule(y + 3);
}

function labcorpClassicHeader(c, spec, pageNo, pageCount, o, hcols) {
  const { patient: p, specimen: s, physician: d, account: a } = spec;
  const hdr = o.header || {};
  c.text(36, 40, 'Labcorp', { bold: true, size: 16 });
  c.text(470, 40, 'Patient Report', { bold: true, size: 10 });
  c.text(36, 62, p.name, { bold: true, size: 11 });
  c.text(36, 80, 'Patient Details', { bold: true });
  c.text(220, 80, 'Specimen Details', { bold: true });
  c.text(420, 80, 'Physician Details', { bold: true });
  const pid = hdr.blankPatientId ? '' : p.patientId;
  let patientPairs;
  if (hdr.combined === 'item') patientPairs = [{ raw: `DOB: ${p.dob}  Age: ${p.age}  Gender: ${p.gender}` }, { label: 'Patient ID', value: pid, key: 'patientId' }, { label: 'Phone', value: p.phone, key: 'phone' }];
  else if (hdr.combined === 'cells') {
    patientPairs = [{ label: 'Patient ID', value: pid, key: 'patientId' }, { label: 'Phone', value: p.phone, key: 'phone' }];
    const x1 = 36 + c.width(`DOB: ${p.dob}`) + 14;
    c.text(36, 92, `DOB: ${p.dob}`); c.text(x1, 92, `Age: ${p.age}`); c.text(x1 + c.width(`Age: ${p.age}`) + 14, 92, `Gender: ${p.gender}`);
  } else patientPairs = [{ label: 'DOB', value: p.dob, key: 'dob' }, { label: 'Age', value: p.age, key: 'age' }, { label: 'Gender', value: p.gender, key: 'sex' }, { label: 'Patient ID', value: pid, key: 'patientId' }, { label: 'Phone', value: p.phone, key: 'phone' }];
  drawLabelColumn(c, 36, hdr.combined === 'cells' ? 103 : 92, 11, patientPairs, hdr, 8);
  drawLabelColumn(c, 220, 92, 11, [
    { label: 'Date collected', value: s.collected, key: 'collected' }, { label: 'Date received', value: s.received, key: 'received' },
    { label: 'Date entered', value: s.entered, key: 'entered' }, { label: 'Date reported', value: s.reported, key: 'reported' },
    { label: 'Specimen ID', value: s.specimenId, key: 'specimenId' }, { label: 'Fasting', value: s.fasting, key: 'fasting' },
  ], hdr, 8);
  drawLabelColumn(c, 420, 92, 11, [
    { label: 'Ordering', value: d.ordering, key: 'ordering' }, { label: 'Referring', value: d.referring, key: 'referring' },
    { label: 'ID', value: d.id, key: 'id' }, { label: 'NPI', value: d.npi, key: 'npi' },
  ], hdr, 8);
  c.text(36, 170, `Account Number: ${a.number}`);
  c.text(220, 170, a.name); c.text(220, 181, a.address1); c.text(220, 192, a.address2);
  c.text(420, 170, `Phone: ${a.phone}`); c.text(420, 181, `Fax: ${a.fax}`); c.text(420, 192, `Rte: ${a.rte}`);
  if (pageNo === 1 && spec.orderedItems) { c.text(36, 212, 'Ordered Items:', { bold: true }); c.text(100, 212, spec.orderedItems); }
  c.rule(239);
  if (!hdr.noTableHeader) tableHeader(c, 236, [[hcols.name, 'TESTS'], [hcols.value, 'RESULT'], [hcols.flag, 'FLAG'], [hcols.unit, 'UNITS'], [hcols.ref, 'REFERENCE INTERVAL'], [hcols.lab, 'LAB']]);
}

function labcorpPortalHeader(c, spec, pageNo, pageCount, o, hcols) {
  const { patient: p, specimen: s, physician: d, account: a } = spec;
  const hdr = o.header || {};
  c.text(36, 40, 'Labcorp', { bold: true, size: 16 });
  c.text(440, 40, 'Lab Results Report', { bold: true, size: 10 });
  const pid = hdr.blankPatientId ? '' : p.patientId;
  const left = hdr.combined
    ? [{ label: 'Patient', value: p.name, key: 'patientName' }, { raw: `Date of Birth: ${p.dob}  Sex: ${p.sex}  Age: ${p.age}` }, { label: 'Patient ID', value: pid, key: 'patientId' }]
    : [{ label: 'Patient', value: p.name, key: 'patientName' }, { label: 'Date of Birth', value: p.dob, key: 'dob' }, { label: 'Sex', value: p.sex, key: 'sex' }, { label: 'Age', value: p.age, key: 'age' }, { label: 'Patient ID', value: pid, key: 'patientId' }];
  drawLabelColumn(c, 36, 70, 11, left, hdr, 8);
  drawLabelColumn(c, 220, 70, 11, [
    { label: 'Specimen #', value: s.specimenId, key: 'specimenId' }, { label: 'Collected', value: s.collected, key: 'collected' },
    { label: 'Received', value: s.received, key: 'received' }, { label: 'Reported', value: s.reported, key: 'reported' }, { label: 'Fasting', value: s.fasting, key: 'fasting' },
  ], hdr, 8);
  drawLabelColumn(c, 420, 70, 11, [
    { label: 'Ordering Physician', value: d.ordering, key: 'ordering' }, { label: 'NPI', value: d.npi, key: 'npi' }, { label: 'Account', value: a.number, key: 'account' }, { raw: a.name },
  ], hdr, 8);
  if (!hdr.noPageOf) c.text(440, 134, `Page ${pageNo} of ${pageCount}`, { size: 7 });
  c.rule(154);
  if (!hdr.noTableHeader) tableHeader(c, 164, [[hcols.name, 'Test Name'], [hcols.value, 'Result'], [hcols.flag, 'Flag'], [hcols.unit, 'Units'], [hcols.ref, 'Reference Interval'], [hcols.lab, 'Lab']]);
}

function labcorpFooter(c, spec, pageNo, pageCount, o) {
  const f = spec.footer; const hdr = o.header || {};
  c.rule(708);
  f.sites.forEach((s, i) => drawLegend(c, 36, 718 + i * 10, s, 7));
  c.text(36, 746, `Date Issued: ${f.dateIssued}`);
  c.text(300, 746, f.status, { bold: true });
  if (!hdr.noPageOf) c.text(520, 746, `Page ${pageNo} of ${pageCount}`);
  c.text(36, 758, f.copyright, { size: 7 });
}

function questClassicHeader(c, spec, pageNo, pageCount, o, hcols) {
  const { patient: p, specimen: s, client: k } = spec;
  const hdr = o.header || {};
  c.text(36, 40, p.name, { bold: true, size: 10 });
  c.text(430, 40, 'Quest Diagnostics', { bold: true, size: 13 });
  c.text(430, 56, 'Report Status:'); c.text(492, 56, spec.status, { bold: true });
  c.text(36, 76, 'Patient Information', { bold: true });
  c.text(220, 76, 'Specimen Information', { bold: true });
  c.text(410, 76, 'Client Information', { bold: true });
  const pid = hdr.blankPatientId ? '' : p.patientId;
  let y = 88;
  c.text(36, y, p.name); y += 11;
  if (hdr.combined === 'item') { c.text(36, y, `DOB: ${p.dob}  AGE: ${p.age}  Gender: ${p.gender}`); y += 11; }
  else {
    c.text(36, y, `DOB: ${p.dob}`); c.text(36 + c.width(`DOB: ${p.dob}`) + 12, y, `AGE: ${p.age}`); y += 11;
    c.text(36, y, `Gender: ${p.gender}`); y += 11;
  }
  drawLabelColumn(c, 36, y, 11, [{ label: 'Patient ID', value: pid, key: 'patientId' }, { label: 'Phone', value: p.phone, key: 'phone' }], hdr, 8);
  drawLabelColumn(c, 220, 88, 11, [
    { label: 'Specimen', value: s.specimenId, key: 'specimenId' }, { label: 'Requisition', value: s.requisition, key: 'requisition' },
    { label: 'Lab Ref #', value: s.labRef, key: 'labRef' }, { label: 'Collected', value: s.collected, key: 'collected' },
    { label: 'Received', value: s.received, key: 'received' }, { label: 'Reported', value: s.reported, key: 'reported' }, { label: 'Fasting', value: s.fasting, key: 'fasting' },
  ], hdr, 8);
  drawLabelColumn(c, 410, 88, 11, [{ label: 'Client #', value: k.number, key: 'client' }, { raw: k.name }, { raw: k.address1 }, { raw: k.address2 }], hdr, 8);
  c.rule(165);
  if (!hdr.noTableHeader) tableHeader(c, 175, [[hcols.name, 'Test Name'], [hcols.inRange, 'In Range'], [hcols.outOfRange, 'Out of Range'], [hcols.ref, 'Reference Range'], [hcols.lab, 'Lab']]);
}

function questFooter(c, spec, pageNo, pageCount, o) {
  const f = spec.footer; const hdr = o.header || {};
  c.rule(696);
  c.text(36, 706, 'PERFORMING SITE:', { bold: true, size: 7 });
  f.sites.forEach((s, i) => drawLegend(c, 36, 716 + i * 10, s, 7));
  c.text(36, 742, f.clientServices, { size: 7 });
  c.text(260, 742, `SPECIMEN: ${spec.specimen.specimenId}`, { size: 7 });
  if (!hdr.noPageOf) c.text(520, 742, `Page ${pageNo} of ${pageCount}`, { size: 7 });
}

function myQuestHeader(c, spec, pageNo, pageCount, o, hcols) {
  const { patient: p, specimen: s, physician: d } = spec;
  const hdr = o.header || {};
  c.text(36, 40, 'MyQuest', { bold: true, size: 16 });
  c.text(430, 40, 'Quest Diagnostics', { bold: true, size: 11 });
  if (hdr.valueBelow && hdr.valueBelow.includes('name')) { c.text(36, 60, 'Results for', { bold: true, size: 12 }); c.text(36, 72, p.displayName, { bold: true, size: 12 }); }
  else c.text(36, 64, `Results for ${p.displayName}`, { bold: true, size: 12 });
  if (hdr.combined === 'item') c.text(36, 80, `Date of Birth: ${p.dob}  Sex: ${p.sex}`, { size: 9 });
  else { c.text(36, 80, `Date of Birth: ${p.dob}`, { size: 9 }); c.text(220, 80, `Sex: ${p.sex}`, { size: 9 }); }
  c.text(36, 93, `Collected on ${s.collected}`, { size: 9 });
  c.text(220, 93, `Reported on ${s.reported}`, { size: 9 });
  if (hdr.valueBelow && hdr.valueBelow.includes('ordering')) { c.text(36, 106, 'Ordered by', { size: 9 }); c.text(36, 117, d.ordering, { size: 9 }); }
  else c.text(36, 106, `Ordered by ${d.ordering}`, { size: 9 });
  c.text(220, 106, `Specimen: ${s.specimenId}`, { size: 9 });
  if (!hdr.noPageOf) c.text(520, 106, `Page ${pageNo} of ${pageCount}`, { size: 8 });
  if (!hdr.noTableHeader) tableHeader(c, 128, [[hcols.name, 'Test'], [hcols.value, 'Your Value'], [hcols.ref, 'Reference Range'], [hcols.flag, 'Flag']], 9);
}

function myQuestFooter(c, spec, pageNo, pageCount, o) {
  const hdr = o.header || {};
  c.rule(720);
  c.text(36, 732, 'Quest, Quest Diagnostics and MyQuest are trademarks of Quest Diagnostics. Sample report for testing only.', { size: 7 });
  c.text(36, 744, 'CLIENT SERVICES: 1.866.697.8378', { size: 7 });
  if (!hdr.noPageOf) c.text(520, 744, `Page ${pageNo} of ${pageCount}`, { size: 7 });
}

const RENDERERS = {
  'labcorp-classic': { header: labcorpClassicHeader, footer: labcorpFooter, line: labcorpBodyLine },
  'labcorp-portal': { header: labcorpPortalHeader, footer: labcorpFooter, line: labcorpBodyLine },
  'quest-classic': { header: questClassicHeader, footer: questFooter, line: questBodyLine },
  'quest-myquest': { header: myQuestHeader, footer: myQuestFooter, line: myQuestBodyLine },
};

/**
 * buildVariant(spec, opts) → { bytes, pageCount }
 * opts: {
 *   cols: column x overrides for the ROWS (merged over BASE_COLUMNS[layout.cols]),
 *   headerCols: column x overrides for the TABLE HEADER LABELS (defaults to cols) — set differently to simulate header/row drift,
 *   fontSize, lineHeight: body row font size / pitch,
 *   rightAlign: x of the right edge of right-aligned value cells (null = left aligned),
 *   flagMode: 'cols' | 'inline' | 'gap2'   (Labcorp/MyQuest; Quest classic: 'gap' (default, 3pt) | 'inline'),
 *   questFlagGap: pt between an out-of-range value and its flag letter (Quest classic),
 *   questUnitsInValueCell: print the unit after the value instead of inside the reference cell,
 *   header: { combined: 'item'|'cells', valueBelow: [keys], blankPatientId, noPageOf, noTableHeader },
 * }
 */
export async function buildVariant(spec, opts = {}) {
  const base = BASE_LAYOUT[spec.layout];
  const r = RENDERERS[spec.layout];
  if (!base || !r) throw new Error(`Unknown layout: ${spec.layout}`);
  const layout = { ...base, fontSize: opts.fontSize || base.fontSize, lineHeight: opts.lineHeight || base.lineHeight };
  const cols = { ...BASE_COLUMNS[base.cols], ...(opts.cols || {}) };
  const hcols = { ...cols, ...(opts.headerCols || {}) };
  const pages = paginate(flowItems(spec), layout);
  const doc = await PDFDocument.create();
  doc.setTitle(spec.file.replace(/\.pdf$/, ''));
  doc.setProducer('family-health adversarial fixture generator');
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  pages.forEach((pg, idx) => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const c = new Canvas(page, fonts, layout.fontSize);
    const pageNo = idx + 1;
    if (!pg.footerOnly) {
      r.header(c, spec, pageNo, pages.length, opts, hcols);
      let y = layout.bodyTop;
      for (const it of pg.items) { r.line(c, y, it, layout, cols, opts); y += layout.lineHeight; }
    }
    r.footer(c, spec, pageNo, pages.length, opts);
  });
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: pages.length };
}
