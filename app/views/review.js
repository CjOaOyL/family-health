// Review view: audit summary, header fields with status chips + inline edits (overrides),
// results table grouped by panel, unparsed lines, member assignment, save / re-parse.
import { el, clear, append, button, chip, statusChip, labelChip, flagChip, vendorChip, confidenceBar, fmtDate, pct, notice, toast, select, errorBox, table, shortId } from '../ui.js';
import { session, removePending, nextPending, navigate, hashFor } from '../state.js';
import { effectiveReport, validateOverride, getPathAny, matchMember, membersSharingDob, displayNameFromReport, rangeText, SETTING_KEEP_FILES, resultPath, resolveOverrides, migrateOverrides, reportHasNoText } from '../reportUtil.js';
import { extractAndParse, getParserVersion, hasPdfjs, getAnalytesModule } from '../pipeline.js';
import { REQUIRED_FIELDS, IMPORTANT_FIELDS } from '../../src/model/schema.js';
import { getReport, putReport, putFile, listMembers, putMember, getSetting, listFileIds, deleteReport, deleteFile } from '../../src/store/db.js';
import { requestSync, ensureFileBytes, remoteFileIds } from '../sync.js';

export const title = 'Review';

const PATIENT_FIELDS = [
  ['patient.fullName', 'Name'], ['patient.dob', 'Date of birth'], ['patient.sex', 'Sex'], ['patient.ageAtCollection', 'Age'],
  ['patient.patientId', 'Patient ID'], ['patient.phone', 'Phone'], ['patient.address', 'Address'],
];
const SPECIMEN_FIELDS = [
  ['specimen.specimenId', 'Specimen ID'], ['specimen.requisition', 'Requisition'], ['specimen.labRef', 'Lab ref'],
  ['specimen.collectedAt', 'Collected'], ['specimen.receivedAt', 'Received'], ['specimen.reportedAt', 'Reported'],
  ['specimen.enteredAt', 'Entered'], ['specimen.fasting', 'Fasting'], ['specimen.collectionSite.name', 'Collection site'],
];
const PROVIDER_FIELDS = [
  ['provider.orderingName', 'Ordering'], ['provider.referringName', 'Referring'], ['provider.npi', 'NPI'],
  ['provider.accountNumber', 'Account #'], ['provider.accountName', 'Account'], ['provider.address', 'Address'],
  ['provider.phone', 'Phone'], ['provider.fax', 'Fax'],
];

export async function render(root, { id }) {
  if (!id) { root.appendChild(notice('No report selected. Import a PDF or open one from Family.', 'warn')); return; }

  // Resolve the record: in-memory pending first, else stored.
  let rec = session.pending.get(id) || null;
  if (!rec) {
    const stored = await getReport(id);
    if (!stored) { root.appendChild(notice('Report not found. It may not have been saved, or the page was reloaded before saving.', 'warn')); root.appendChild(el('p', el('a', { href: '#/import' }, 'Go to Import'))); return; }
    rec = { ...stored, doc: session.docs.get(id) || null, bytes: null, error: null, stored: true };
  }
  // Legacy id-keyed result overrides are rekeyed against the report they were made on, before anything else.
  migrateOverrides(rec, rec.report);
  // Analyte dictionary: needed so unit/name edits recompute canonical fields.
  await getAnalytesModule();

  const members = await listMembers();
  const fileIds = await listFileIds().catch(() => []);
  // The PDF may live only in Drive (saved on another device): re-parse can fetch it on demand.
  const hasStoredFile = fileIds.includes(id) || remoteFileIds().includes(id);
  const parserVersion = await getParserVersion();
  const keepFiles = await getSetting(SETTING_KEEP_FILES, true);

  const state = { rec, members, dirty: false, editing: null, hasStoredFile, parserVersion, keepFiles };

  // Auto-match member if not assigned.
  if (!state.rec.memberId && state.rec.report) {
    const m = matchMember(state.rec.report, members);
    if (m) state.rec.memberId = m.id;
  }

  const page = el('div');
  root.appendChild(page);
  draw();

  function noText() { return !!state.rec.report && reportHasNoText(state.rec.report, state.rec.doc); }

  function draw() {
    clear(page);
    const { rec } = state;
    page.appendChild(el('div', { class: 'page-title' }, el('h1', 'Review report'), el('span', { class: 'muted small mono' }, rec.fileName || rec.report?.source?.fileName || shortId(rec.id))));

    if (!rec.report) {
      if (!rec.doc) {
        // Extraction itself failed: there is no text to show and nothing to re-parse.
        page.appendChild(errorBox(rec.error || new Error('The file could not be opened as a PDF.'), 'This file is not a readable PDF'));
        page.appendChild(el('p', { class: 'text-2' }, 'Nothing could be extracted. Check that the file is a real PDF (not a renamed document or image) and try again.'));
        page.appendChild(actionsBar());
        return;
      }
      page.appendChild(errorBox(rec.error || new Error('No report produced'), 'Parsing failed'));
      page.appendChild(el('p', { class: 'text-2' }, 'The PDF text was extracted; below is everything the PDF contained so you can see what went wrong.'));
      page.appendChild(actionsBar());
      page.appendChild(rawLinesPanel(rec.doc, true));
      return;
    }
    if (rec.error) page.appendChild(errorBox(rec.error, 'Parser reported an error'));

    if (noText()) {
      page.appendChild(notice('No text found in this PDF (scanned image?). Nothing can be extracted.', 'error'));
      page.appendChild(el('p', { class: 'text-2 small' }, 'This PDF has pages but no text layer, so there are no fields or results to review and it cannot be saved. If it is a scan, ask the lab for the original PDF or a text-searchable copy.'));
      page.appendChild(actionsBar());
      page.appendChild(rawLinesPanel(rec.doc, false));
      return;
    }

    const report = effectiveReport(rec);
    append(page,
      summaryCard(report),
      orphanNotice(),
      actionsBar(),
      memberCard(report),
      el('div', { class: 'grid-2' },
        fieldSection('Patient', PATIENT_FIELDS, report),
        fieldSection('Specimen', SPECIMEN_FIELDS, report),
        fieldSection('Provider', PROVIDER_FIELDS, report),
        labsSection(report)),
      resultsSection(report),
      commentsSection(report),
      unparsedPanel(report),
      rawLinesPanel(rec.doc, false),
    );
  }

  // ---------- summary ----------
  function summaryCard(report) {
    const a = report.audit || {};
    const overall = typeof a.overall === 'number' ? a.overall : 0;
    const label = a.label || 'incomplete';
    const pages = a.pages || {};
    const seen = pages.seen ?? report.source?.pageCount ?? '?';
    const declared = pages.declared ?? seen;
    const meter = el('div', { class: `meter ${label}` }, el('i'));
    meter.querySelector('i').style.width = `${Math.round(overall * 100)}%`;
    const cov = a.coverage || {};
    // Repeated warnings (one per page, e.g. "Unrecognized header fragment … at p2l9") collapse to one line
    // with a count; a trailing line location is stripped for grouping and the locations are listed once.
    const groups = new Map();
    for (const w of Array.isArray(a.warnings) ? a.warnings : []) {
      const s = String(w);
      const m = s.match(/^(.*?)\s+at\s+(p\d+l\d+)\.?$/);
      const k = m ? m[1] : s;
      const g = groups.get(k) || { n: 0, where: [] };
      g.n++; if (m) g.where.push(m[2]);
      groups.set(k, g);
    }
    const warnings = Array.from(groups, ([text, g]) => el('li', text,
      g.n > 1 ? el('span', { class: 'count' }, `(×${g.n}${g.where.length ? ' · ' + g.where.join(', ') : ''})`) : (g.where.length ? el('span', { class: 'count' }, `at ${g.where[0]}`) : null)));
    return el('section', { class: 'card' },
      el('div', { class: 'summary' },
        el('div', el('div', { class: 'score' }, String(Math.round(overall * 100)), el('small', '%')), labelChip(label)),
        el('div', { class: 'meta' },
          el('span', { class: 'fn' }, report.source?.fileName || rec.fileName || ''),
          el('span', { class: 'row' }, vendorChip(report.source?.vendor, `vendor confidence ${pct(report.source?.vendorConfidence || 0)}`),
            report.source?.reportStatus ? chip(String(report.source.reportStatus), 'muted') : null,
            chip(`${report.results?.length || 0} results`, 'muted'),
            rec.stored ? chip('saved', 'accent') : chip('not saved', 'warning')),
          el('span', `${seen} of ${declared} pages seen${pages.complete === false ? ' — incomplete' : ''}`),
          el('span', `${cov.consumedLines ?? '?'} of ${cov.totalLines ?? '?'} lines consumed · ${cov.resultLikeUnconsumed ?? 0} result-like lines unparsed`),
          el('span', { class: 'muted small' }, `Collected ${fmtDate(report.specimen?.collectedAt) || '—'} · parser ${report.source?.parserVersion || '?'}`))),
      meter,
      warnings.length ? el('ul', { class: 'warnings' }, warnings) : null);
  }

  /** Edits whose result no longer exists after a re-parse (stable key did not match any current result). */
  function orphanNotice() {
    const { orphaned } = resolveOverrides(state.rec);
    if (!orphaned.length) return null;
    const items = orphaned.map((o) => el('li',
      el('span', { class: 'mono' }, o.name), ` · ${o.field} → `, el('strong', String(o.value)), ' ',
      button('Drop', () => { delete state.rec.overrides[o.path]; state.dirty = true; draw(); }, { small: true, kind: 'ghost', title: 'Forget this edit' })));
    const n = orphaned.length;
    return el('div', { class: 'notice warn' },
      el('strong', `${n} edit${n === 1 ? '' : 's'} could not be re-applied after re-parse: `),
      orphaned.map((o) => `${o.name} → ${o.value}`).join('; '),
      el('p', { class: 'small', style: { margin: '6px 0 0' } }, 'The parser no longer produces a result with the same source line and test name. Re-enter the value on the right row if it is still needed, then drop the stale edit.'),
      el('ul', { class: 'warnings' }, items));
  }

  // ---------- actions ----------
  function actionsBar() {
    const { rec } = state;
    const canSave = !!rec.report && !noText();
    const next = nextPending(rec.id);
    const needsReparse = canSave && state.parserVersion && rec.report?.source?.parserVersion && rec.report.source.parserVersion !== state.parserVersion;
    const bytesAvailable = !!rec.bytes || state.hasStoredFile;
    // Re-parse only makes sense when extraction worked at least once (doc present) or the PDF is stored.
    const canReparse = bytesAvailable && hasPdfjs() && (!!rec.doc || rec.stored);
    const bar = el('div', { class: 'card toolbar' },
      button(rec.stored ? 'Save changes' : 'Save report', save, { kind: 'primary', disabled: !canSave, title: !rec.report ? 'Nothing was parsed' : noText() ? 'No text was found in this PDF' : null }),
      next ? button('Next pending', () => navigate(hashFor('review', next))) : null,
      canReparse ? button(needsReparse ? `Re-parse (parser ${state.parserVersion})` : 'Re-parse', reparse, { title: 'Run the extractor and parser again on the stored PDF bytes. Your edits are kept.' }) : null,
      el('span', { class: 'spacer' }),
      rec.stored ? button('Delete', remove, { kind: 'danger' }) : button('Discard', discard, { kind: 'ghost' }),
    );
    if (needsReparse) bar.appendChild(notice(`Stored with parser ${rec.report.source.parserVersion}; current parser is ${state.parserVersion}.`, 'warn'));
    if (state.dirty) bar.appendChild(chip('unsaved edits', 'warning'));
    return bar;
  }

  async function save() {
    const { rec } = state;
    if (!rec.report || noText()) return;
    try {
      const memberId = rec.memberId || null;
      const { orphaned } = resolveOverrides(rec);
      const stored = await putReport({ id: rec.id, memberId, overrides: rec.overrides || {}, orphanedOverrides: orphaned, report: rec.report, savedAt: rec.savedAt || undefined });
      if (rec.bytes && state.keepFiles) { await putFile({ id: rec.id, bytes: rec.bytes, fileName: rec.fileName }); state.hasStoredFile = true; }
      rec.stored = true; rec.savedAt = stored.savedAt; state.dirty = false;
      if (rec.doc) session.docs.set(rec.id, rec.doc);
      const next = nextPending(rec.id);
      removePending(rec.id);
      requestSync('save');
      toast(memberId ? 'Report saved' : 'Report saved (no member assigned)');
      if (next) navigate(hashFor('review', next));
      else if (memberId) navigate(hashFor('results', null, { member: memberId }));
      else draw();
    } catch (err) {
      page.prepend(errorBox(err, 'Save failed'));
    }
  }

  async function reparse() {
    const { rec } = state;
    let bytes = rec.bytes;
    if (!bytes) {
      toast('Fetching the stored PDF…');
      const f = await ensureFileBytes(rec.id, { fileName: rec.fileName || rec.report?.source?.fileName || null });
      bytes = f?.bytes || null;
      if (f && f.source === 'drive') state.hasStoredFile = true;
    }
    if (!bytes) { toast('No stored PDF for this report on this device or in Drive'); return; }
    toast('Re-parsing…');
    // Overrides are keyed by stable result keys (migrated above), so they re-attach by line + name, not by id.
    const { doc, report, error } = await extractAndParse(bytes, rec.fileName || rec.report?.source?.fileName || 'report.pdf');
    rec.doc = doc; rec.bytes = bytes; rec.error = error;
    if (report) {
      rec.report = report; state.dirty = true;
      const { orphaned } = resolveOverrides(rec, report);
      rec.orphanedOverrides = orphaned;
      if (orphaned.length) toast(`Re-parsed; ${orphaned.length} edit${orphaned.length === 1 ? '' : 's'} could not be re-applied`, 4000);
    }
    if (doc) session.docs.set(rec.id, doc);
    draw();
  }

  async function remove() {
    if (!confirm('Delete this report and its stored PDF? This cannot be undone.')) return;
    await deleteReport(state.rec.id);
    await deleteFile(state.rec.id).catch(() => {});
    removePending(state.rec.id);
    requestSync('report-delete');
    toast('Report deleted');
    navigate('#/family');
  }

  function discard() {
    if (!confirm('Discard this unsaved report?')) return;
    const next = nextPending(state.rec.id);
    removePending(state.rec.id);
    navigate(next ? hashFor('review', next) : '#/import');
  }

  // ---------- member ----------
  function memberCard(report) {
    const { rec } = state;
    const current = state.members.find((m) => m.id === rec.memberId) || null;
    const suggested = displayNameFromReport(report);
    const sel = select({
      placeholder: '— choose member —',
      options: state.members.map((m) => ({ value: m.id, label: `${m.name}${m.dob ? ' · ' + fmtDate(m.dob) : ''}` })),
      value: rec.memberId || '',
      onChange: (v) => { rec.memberId = v || null; state.dirty = true; draw(); },
    });
    const create = button(`Create member “${suggested || 'Unnamed'}”`, async () => {
      const m = await putMember({ name: suggested || 'Unnamed', dob: report.patient?.dob || null, sex: report.patient?.sex || null });
      state.members = await listMembers();
      rec.memberId = m.id; state.dirty = true;
      requestSync('member-add');
      toast(`Member ${m.name} created`);
      draw();
    }, { small: true });
    // Siblings/twins: several members share this DOB and the name alone did not settle it → list them.
    const sameDob = !current ? membersSharingDob(report, state.members) : [];
    const candidates = sameDob.length > 1
      ? el('div', { class: 'notice warn', style: { marginTop: '8px' } },
        el('strong', `${sameDob.length} members share this date of birth. `), 'Pick the right one: ',
        el('span', { class: 'row', style: { marginTop: '6px' } }, sameDob.map((m) => button(`Assign to ${m.name}`, () => { rec.memberId = m.id; state.dirty = true; draw(); }, { small: true }))))
      : null;
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', 'Family member'), current ? chip(matchMember(report, [current]) ? 'auto-matched' : 'assigned', 'accent') : chip('unassigned', 'warning')),
      el('div', { class: 'row' }, sel, !current ? create : null),
      candidates,
      el('p', { class: 'muted small' }, current
        ? `Assigned to ${current.name}. Report patient: ${report.patient?.fullName || '—'}, DOB ${fmtDate(report.patient?.dob) || '—'}.`
        : `Matched by name and date of birth against existing members. Report patient: ${report.patient?.fullName || '—'}, DOB ${fmtDate(report.patient?.dob) || '—'}.`));
  }

  // ---------- header fields ----------
  /**
   * Chip status for a header field. Required fields are red when missing; important fields follow the
   * audit ('missing' red, 'na' neutral); everything else is optional and shows a neutral n/a when absent.
   */
  function fieldStatus(report, path) {
    const f = report.audit?.fields?.[path];
    const v = getPathAny(report, path);
    const present = !(v == null || v === '' || (Array.isArray(v) && !v.length));
    if (present) return f && f.status && f.status !== 'missing' && f.status !== 'na' ? f.status : 'found';
    if (REQUIRED_FIELDS.includes(path)) return f && f.status ? f.status : 'missing';
    if (IMPORTANT_FIELDS.includes(path)) return f && f.status ? f.status : 'na';
    return 'na';
  }

  function fieldSection(name, fields, report) {
    const kv = el('div', { class: 'kv' });
    for (const [path, label] of fields) {
      const value = getPathAny(report, path);
      const overridden = Object.prototype.hasOwnProperty.call(state.rec.overrides || {}, path);
      const original = overridden ? getPathAny(state.rec.report, path) : undefined;
      append(kv,
        el('span', { class: 'k' }, label),
        el('span', { class: 'v' }, editable(path, value, formatField(path, value), formatField(path, original)), ...(path === 'specimen.collectedAt' && report.specimen?.collectedTz ? [' ', el('span', { class: 'muted small' }, report.specimen.collectedTz)] : [])),
        el('span', { class: 's' }, overridden ? statusChip('edited') : statusChip(fieldStatus(report, path)), overridden ? button('↺', () => clearOverride(path), { small: true, kind: 'icon', title: 'Restore parsed value' }) : null),
      );
    }
    return el('section', { class: 'card' }, el('h3', name), kv);
  }

  function labsSection(report) {
    const labs = report.performingLabs || [];
    const body = labs.length
      ? el('div', { class: 'stack' }, labs.map((l, i) => el('div', { class: 'kv' },
        el('span', { class: 'k' }, 'Code'), el('span', { class: 'v' }, editable(`performingLabs.${i}.code`, l.code, l.code)), el('span', { class: 's' }, statusChip(l.code ? 'found' : 'missing')),
        el('span', { class: 'k' }, 'Name'), el('span', { class: 'v' }, editable(`performingLabs.${i}.name`, l.name, l.name)), el('span', { class: 's' }, statusChip(l.name ? 'found' : 'missing')),
        el('span', { class: 'k' }, 'Address'), el('span', { class: 'v' }, editable(`performingLabs.${i}.address`, l.address, l.address)), el('span', { class: 's' }),
        el('span', { class: 'k' }, 'Director'), el('span', { class: 'v' }, editable(`performingLabs.${i}.director`, l.director, l.director)), el('span', { class: 's' }),
        el('span', { class: 'k' }, 'CLIA'), el('span', { class: 'v' }, editable(`performingLabs.${i}.clia`, l.clia, l.clia)), el('span', { class: 's' }),
        el('span', { class: 'k' }, 'Phone'), el('span', { class: 'v' }, editable(`performingLabs.${i}.phone`, l.phone, l.phone)), el('span', { class: 's' }),
      )))
      : el('p', { class: 'muted small' }, 'No performing-lab legend found.');
    return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', 'Performing labs'), statusChip(fieldStatus(report, 'performingLabs'))), body);
  }

  function formatField(path, v) {
    if (v == null || v === '') return '';
    const last = path.split('.').pop();
    if (/At$|^dob$/.test(last)) return fmtDate(v);
    if (last === 'fasting') return v ? 'Yes' : 'No';
    return String(v);
  }

  function rawEditText(path, v) {
    if (v == null) return '';
    const last = path.split('.').pop();
    if (last === 'fasting') return v ? 'yes' : 'no';
    return String(v);
  }

  /** Clickable value → inline input → override. */
  function editable(path, value, display, originalDisplay) {
    const isEmpty = value == null || value === '';
    const span = el('span', { class: `editable${isEmpty ? ' empty' : ''}`, tabindex: '0', role: 'button', title: 'Click to edit' }, isEmpty ? '— click to add' : display);
    const wrap = el('span', span, originalDisplay != null && originalDisplay !== '' && originalDisplay !== display ? el('span', { class: 'orig', title: 'Parsed value' }, originalDisplay) : null);
    const startEdit = () => {
      const input = el('input', { type: 'text', value: rawEditText(path, value), class: 'inline' });
      let done = false;
      const finish = (commit) => {
        if (done) return; done = true;
        if (commit) setOverride(path, input.value); else draw();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
      wrap.replaceChildren(input);
      input.focus(); input.select();
    };
    span.addEventListener('click', startEdit);
    span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); } });
    return wrap;
  }

  /** Validate, then store an override. Invalid input is rejected with a toast and the old value stays. */
  function setOverride(path, text) {
    const { rec } = state;
    const v = validateOverride(path, text);
    if (!v.ok) { toast(v.error); draw(); return false; }
    const coerced = v.value;
    const original = getPathAny(rec.report, path);
    rec.overrides = rec.overrides || {};
    if ((coerced == null && (original == null || original === '')) || coerced === original) delete rec.overrides[path];
    else rec.overrides[path] = coerced;
    state.dirty = true;
    draw();
    return true;
  }

  function clearOverride(path) {
    delete state.rec.overrides[path];
    state.dirty = true;
    draw();
  }

  // ---------- results ----------
  function resultsSection(report) {
    const results = report.results || [];
    const panels = report.panels || [];
    const byId = new Map(results.map((r) => [r.id, r]));
    const placed = new Set();
    const groups = [];
    for (const p of panels) {
      const rows = (p.resultIds || []).map((rid) => byId.get(rid)).filter(Boolean);
      rows.forEach((r) => placed.add(r.id));
      groups.push({ name: p.name, rows });
    }
    // Results that reference a panel by name but are not listed in panels[], then anything else.
    const leftovers = results.filter((r) => !placed.has(r.id));
    const byPanel = new Map();
    for (const r of leftovers) { const k = r.panel || ''; if (!byPanel.has(k)) byPanel.set(k, []); byPanel.get(k).push(r); }
    for (const [k, rows] of byPanel) {
      const g = groups.find((x) => x.name === k);
      if (g) g.rows.push(...rows); else groups.push({ name: k || 'Other', rows });
    }
    const lowCount = results.filter((r) => (r.confidence ?? 0) < 0.8).length;
    const trows = [];
    for (const g of groups) {
      if (!g.rows.length) continue;
      trows.push({ class: 'panel', span: [g.name, el('span', { class: 'muted small' }, ` · ${g.rows.length}`)] });
      for (const r of g.rows) trows.push(resultRow(r, report));
    }
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', 'Results'), chip(`${results.length} rows`, 'muted'), lowCount ? chip(`${lowCount} low confidence`, 'warning') : chip('all ≥ 80% confidence', 'good')),
      results.length ? table({ head: ['Test', 'Value', 'Unit', 'Flag', 'Reference', 'Lab', 'Conf.'], rows: trows, numeric: [1] })
        : el('p', { class: 'muted' }, 'No result rows were parsed.'));
  }

  function resultRow(r, report) {
    // Override paths use the stable key of the ORIGINAL (stored) result, so an edited name does not move the key.
    const orig = (state.rec.report?.results || []).find((x) => x.id === r.id) || r;
    const path = (field) => resultPath(orig, field);
    const ov = state.rec.overrides || {};
    const edited = (p) => Object.prototype.hasOwnProperty.call(ov, path(p));
    const low = (r.confidence ?? 0) < 0.8;
    const issues = Object.entries(r.fieldStatus || {}).filter(([, s]) => s === 'missing' || s === 'uncertain').map(([k, s]) => `${k}: ${s}`).join(', ');
    const canon = r.canonicalUnit && r.unit && r.canonicalValue != null && r.canonicalValue !== r.value
      ? el('span', { class: 'sub', title: 'Converted to the canonical unit for comparison' }, `= ${r.canonicalValue} ${r.canonicalUnit}`) : null;
    const nameCell = el('span', editable(path('name'), r.name, r.name), edited('name') ? el('span', { class: 'chip chip-edited' }, '✎') : null, r.comment ? el('span', { class: 'sub' }, r.comment) : null);
    const valueCell = el('span', editable(path('valueText'), r.valueText, r.valueText), edited('valueText') ? el('span', { class: 'chip chip-edited' }, '✎') : null, canon);
    const unitCell = el('span', editable(path('unit'), r.unit, r.unit), edited('unit') ? el('span', { class: 'chip chip-edited' }, '✎') : null);
    return {
      class: low ? 'low' : null,
      cells: [
        nameCell,
        valueCell,
        unitCell,
        el('span', flagChip(r.flag), ' ', el('span', { class: 'editable small muted', tabindex: '0', title: 'Edit flag (H, L, HH, LL, A, C or blank)', role: 'button', onClick: (e) => editFlag(e, r, path('flag')), onKeydown: (e) => { if (e.key === 'Enter') editFlag(e, r, path('flag')); } }, '✎'), edited('flag') ? el('span', { class: 'chip chip-edited' }, '✎') : null),
        el('span', editable(path('referenceRange.text'), r.referenceRange?.text ?? (rangeText(r.referenceRange) || null), rangeText(r.referenceRange)), edited('referenceRange.text') ? el('span', { class: 'chip chip-edited' }, '✎') : null),
        el('span', { class: 'mono small' }, r.performingLabCode || ''),
        el('span', { title: issues || 'all fields found' }, confidenceBar(r.confidence)),
      ],
    };
  }

  function editFlag(e, r, path) {
    e.preventDefault();
    const v = prompt('Flag (H, L, HH, LL, A, C) or blank for none', r.flag || '');
    if (v === null) return;
    setOverride(path, v);
  }

  function commentsSection(report) {
    const comments = (report.comments || []).filter((c) => !c.attachedTo);
    if (!comments.length) return null;
    return el('details', { class: 'panel' }, el('summary', 'Report comments ', chip(String(comments.length), 'muted')),
      el('div', { class: 'body' }, el('ul', { class: 'lines' }, comments.map((c) => el('li', el('span', { class: 'pg' }, `p${c.page}`), el('span', c.text))))));
  }

  // ---------- unparsed ----------
  function unparsedPanel(report) {
    const cov = report.audit?.coverage || {};
    const lines = Array.isArray(cov.unconsumed) ? cov.unconsumed : [];
    // Lines the parser swallowed as comments/continuations but that look like result rows (audit may add this).
    const suspicious = Array.isArray(cov.suspiciousConsumed) ? cov.suspiciousConsumed : [];
    const rl = lines.filter((l) => l.resultLike).length;
    const lineItem = (l) => el('li', { class: l.resultLike !== false ? 'rl' : null }, el('span', { class: 'pg' }, `p${l.page ?? '?'}`), el('span', String(l.text ?? '')));
    const details = el('details', { class: 'panel', open: rl > 0 || suspicious.length > 0 },
      el('summary', 'Unparsed lines ', chip(String(lines.length), lines.length ? 'warning' : 'good'), rl ? chip(`${rl} result-like`, 'critical') : null,
        suspicious.length ? chip(`${suspicious.length} consumed but result-like`, 'critical') : null),
      el('div', { class: 'body' },
        lines.length
          ? el('ul', { class: 'lines' }, lines.map((l) => el('li', { class: l.resultLike ? 'rl' : null }, el('span', { class: 'pg' }, `p${l.page}`), el('span', l.text))))
          : el('p', { class: 'muted small' }, 'Every line of the PDF was consumed by the parser.'),
        suspicious.length ? el('div',
          el('p', { class: 'lines-head' }, 'Consumed as comment but looks like a result'),
          el('ul', { class: 'lines' }, suspicious.map((l) => lineItem({ ...l, resultLike: true })))) : null));
    return details;
  }

  function rawLinesPanel(doc, open) {
    if (!doc || !Array.isArray(doc.pages)) {
      return el('details', { class: 'panel', open },
        el('summary', 'All extracted lines'),
        el('div', { class: 'body' }, el('p', { class: 'muted small' }, 'The extracted text is only kept in memory during import. Use Re-parse to re-extract from the stored PDF.')));
    }
    const items = [];
    for (const p of doc.pages) for (const l of p.lines || []) items.push(el('li', el('span', { class: 'pg' }, l.id || `p${p.pageNumber}`), el('span', l.text)));
    return el('details', { class: 'panel', open },
      el('summary', 'All extracted lines ', chip(`${items.length} lines · ${doc.pages.length} pages`, 'muted')),
      el('div', { class: 'body' }, items.length ? el('ul', { class: 'lines' }, items) : el('p', { class: 'muted small' }, 'No text lines were extracted from this PDF.')));
  }
}
