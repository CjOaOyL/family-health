// Settings: backup export/import, keep-PDF toggle, clear data, parser version + re-parse all,
// redacted diagnostic copy, and the (disabled) Assist placeholder.
import { el, clear, append, button, chip, select, fmtDate, toast, download, notice, errorBox, copyText, vendorLabel } from '../ui.js';
import { SETTING_KEEP_FILES, effectiveReport } from '../reportUtil.js';
import { moduleStatus, extractAndParse, redact, hasPdfjs } from '../pipeline.js';
import { exportAll, importAll, clearAll, getSetting, setSetting, counts, listReports, listFileMeta, getFile, putReport, listMembers } from '../../src/store/db.js';

export const title = 'Settings';

export async function render(root) {
  const page = el('div');
  root.appendChild(page);
  await draw();

  async function draw() {
    clear(page);
    const [keep, c, status, reports, files, members] = await Promise.all([
      getSetting(SETTING_KEEP_FILES, true), counts(), moduleStatus(), listReports(), listFileMeta(), listMembers(),
    ]);
    append(page, 
      el('div', { class: 'page-title' }, el('h1', 'Settings'), el('span', { class: 'muted small' }, `${c.reports} reports · ${c.members} members · ${c.files} stored PDFs`)),
      backupCard(),
      storageCard(keep, c, files),
      parserCard(status, reports, files),
      diagnosticCard(reports, files, members, status),
      assistCard(),
      aboutCard(status),
    );
  }

  function backupCard() {
    const withFiles = el('input', { type: 'checkbox' });
    const fileInput = el('input', { type: 'file', accept: 'application/json,.json' });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0]; fileInput.value = '';
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        const n = (obj.reports?.length || 0) + (obj.members?.length || 0);
        if (!confirm(`Merge ${obj.members?.length || 0} members, ${obj.reports?.length || 0} reports${obj.files?.length ? `, ${obj.files.length} PDFs` : ''} into this device? Existing items with the same id are replaced.`)) return;
        const res = await importAll(obj, { merge: true });
        toast(`Imported ${res.members} members, ${res.reports} reports, ${res.files} PDFs`);
        if (!n) toast('Backup contained no reports or members');
        await draw();
      } catch (err) { page.prepend(errorBox(err, 'Import failed')); }
    });
    return el('section', { class: 'card' },
      el('h2', 'Backup'),
      el('p', { class: 'text-2 small' }, 'Everything lives in this browser. Export a JSON backup to move it to another device or keep a copy.'),
      el('div', { class: 'toolbar' },
        button('Export JSON backup', async () => {
          try {
            const obj = await exportAll({ includeFiles: withFiles.checked });
            download(`family-health-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(obj), 'application/json');
            toast('Backup downloaded');
          } catch (err) { page.prepend(errorBox(err, 'Export failed')); }
        }, { kind: 'primary' }),
        el('label', { class: 'check small' }, withFiles, 'include original PDFs (larger file)'),
        el('span', { class: 'spacer' }),
        button('Import JSON (merge)', () => fileInput.click()), fileInput));
  }

  function storageCard(keep, c, files) {
    const size = files.reduce((s, f) => s + (f.size || 0), 0);
    const toggle = el('input', { type: 'checkbox', checked: !!keep });
    toggle.addEventListener('change', async () => { await setSetting(SETTING_KEEP_FILES, toggle.checked); toast(toggle.checked ? 'Original PDFs will be kept' : 'New imports will not keep the PDF'); });
    return el('section', { class: 'card' },
      el('h2', 'Storage'),
      el('label', { class: 'check' }, toggle, el('span', 'Keep original PDFs ', el('span', { class: 'muted small' }, `(needed for re-parsing after parser updates; ${c.files} stored, ${(size / 1048576).toFixed(1)} MB)`))),
      el('div', { class: 'toolbar', style: { marginTop: '12px' } },
        button('Clear all data', async () => {
          if (!confirm(`Delete ALL ${c.reports} reports, ${c.members} members and ${c.files} PDFs from this browser? This cannot be undone.`)) return;
          if (!confirm('Really delete everything? Export a backup first if you are not sure.')) return;
          await clearAll();
          toast('All data cleared');
          await draw();
        }, { kind: 'danger' })));
  }

  function parserCard(status, reports, files) {
    const fileIds = new Set(files.map((f) => f.id));
    const stale = reports.filter((r) => status.parserVersion && r.report?.source?.parserVersion !== status.parserVersion);
    const reparsable = reports.filter((r) => fileIds.has(r.id));
    const log = el('ul', { class: 'progress' });
    const run = button(`Re-parse all stored PDFs (${reparsable.length})`, async () => {
      if (!reparsable.length) { toast('No stored PDFs to re-parse'); return; }
      run.disabled = true;
      clear(log);
      let ok = 0, failed = 0;
      for (const rec of reparsable) {
        const li = el('li', el('span', { class: 'spinner' }), el('span', { class: 'fn' }, rec.report?.source?.fileName || rec.id), el('span', { class: 'muted small status' }, 'parsing…'));
        log.appendChild(li);
        try {
          const f = await getFile(rec.id);
          const { report, error } = await extractAndParse(f.bytes, f.fileName || rec.report?.source?.fileName || 'report.pdf');
          if (!report) throw error || new Error('no report');
          await putReport({ ...rec, report });
          ok++;
          li.querySelector('.spinner').replaceWith(el('span', '✓'));
          li.querySelector('.status').replaceChildren(chip(report.audit?.label || 'parsed', report.audit?.label || 'muted'), ` ${report.results?.length || 0} results · parser ${report.source?.parserVersion || '?'}`);
        } catch (err) {
          failed++;
          li.querySelector('.spinner').replaceWith(el('span', '⚠'));
          li.querySelector('.status').textContent = `failed: ${err.message || err}`;
        }
      }
      toast(`Re-parsed ${ok}${failed ? `, ${failed} failed` : ''}`);
      run.disabled = false;
    }, { disabled: !hasPdfjs() || !status.parser || !status.extractor });
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', 'Parser'), chip(status.parserVersion ? `v${status.parserVersion}` : 'unavailable', status.parserVersion ? 'accent' : 'critical')),
      el('p', { class: 'text-2 small' }, stale.length ? `${stale.length} stored report${stale.length === 1 ? ' was' : 's were'} parsed with an older parser version. Overrides and member assignments are kept when re-parsing.` : 'All stored reports are up to date with the current parser.'),
      el('div', { class: 'toolbar' }, run),
      log);
  }

  function diagnosticCard(reports, files, members, status) {
    const fileIds = new Set(files.map((f) => f.id));
    const opts = reports.map((r) => ({ value: r.id, label: `${fmtDate(r.report?.specimen?.collectedAt, { time: false }) || 'no date'} · ${vendorLabel(r.report?.source?.vendor)} · ${members.find((m) => m.id === r.memberId)?.name || 'unassigned'} · ${r.report?.source?.fileName || r.id}${fileIds.has(r.id) ? '' : ' (no stored PDF)'}` }));
    const sel = select({ placeholder: reports.length ? '— choose report —' : 'No stored reports', options: opts });
    const out = el('textarea', { rows: 10, readonly: true, placeholder: 'Redacted diagnostic text appears here.' });
    out.classList.add('hidden');
    const go = button('Copy redacted diagnostic', async () => {
      const rec = reports.find((r) => r.id === sel.value);
      if (!rec) { toast('Choose a report'); return; }
      if (!fileIds.has(rec.id)) { toast('This report has no stored PDF; the diagnostic needs the extracted text.'); return; }
      try {
        const f = await getFile(rec.id);
        const { doc, error } = await extractAndParse(f.bytes, f.fileName || 'report.pdf');
        if (!doc) throw error || new Error('extraction failed');
        const text = await redact(effectiveReport(rec), doc);
        out.value = text; out.classList.remove('hidden');
        toast((await copyText(text)) ? 'Copied to clipboard' : 'Could not copy automatically; select the text below');
      } catch (err) { page.prepend(errorBox(err, 'Diagnostic failed')); }
    }, { disabled: !status.redact || !hasPdfjs() });
    return el('section', { class: 'card' },
      el('h2', 'Redacted diagnostic'),
      el('p', { class: 'text-2 small' }, 'Produces a shareable text dump of a report with identity fields masked (names, DOB, ids, phones), for debugging the parser. Review it before sharing.'),
      el('div', { class: 'row' }, sel, go),
      out);
  }

  function assistCard() {
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', 'Assist (optional)'), chip('off', 'muted')),
      el('p', { class: 'text-2 small' }, 'An optional language-model assist for lines the deterministic parser could not read. It is not available yet. When it ships it will be off by default, require your own API key, and only ever send redacted unparsed fragments — never names, dates of birth, ids, or the PDF itself.'),
      el('div', { class: 'row' }, el('input', { type: 'password', placeholder: 'API key (not yet supported)', disabled: true }), button('Enable', null, { disabled: true })));
  }

  function aboutCard(status) {
    const row = (k, ok, err) => el('li', chip(ok ? 'ok' : 'missing', ok ? 'good' : 'critical'), ` ${k}`, err ? el('span', { class: 'muted small' }, ` — ${err}`) : null);
    return el('section', { class: 'card' },
      el('h2', 'About'),
      el('p', { class: 'text-2 small' }, 'Family Health runs entirely in your browser. Lab PDFs are parsed with deterministic rules; nothing is uploaded. pdf.js (4.10.38) is the only remote code loaded.'),
      el('ul', { class: 'members small' },
        row('pdf.js engine', status.pdfjs, status.pdfjsError),
        row('PDF extractor', status.extractor, status.extractorError),
        row('Parser', status.parser, status.parserError),
        row('Analyte dictionary', status.analytes, status.analytesError),
        row('Redaction', status.redact, status.redactError)),
      el('p', { class: 'muted small' }, notice('Tip: if you clear this site\'s data in your browser, everything here is gone. Keep a backup.')));
  }
}
