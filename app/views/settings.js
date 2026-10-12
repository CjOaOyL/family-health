// Settings: Google Drive sync, backup export/import, keep-PDF toggle, clear data, parser version + re-parse all,
// redacted diagnostic copy, and the (disabled) Assist placeholder.
import { el, clear, append, button, chip, select, fmtDate, toast, download, notice, errorBox, copyText, vendorLabel, todayIso } from '../ui.js';
import { SETTING_KEEP_FILES, effectiveReport, migrateOverrides, resolveOverrides } from '../reportUtil.js';
import { moduleStatus, extractAndParse, redact, hasPdfjs, getAnalytesModule } from '../pipeline.js';
import { exportAll, importAll, getSetting, setSetting, counts, listReports, listFileMeta, putReport, listMembers } from '../../src/store/db.js';
import { getSyncStatus, onSyncStatus, connect, disconnect, syncNow, requestSync, setClientId, configClientId, ensureFileBytes, remoteFileIds, relTime, DRIVE_SCOPE } from '../sync.js';

export const title = 'Settings';

export async function render(root) {
  const page = el('div');
  root.appendChild(page);
  let unsubscribe = null;
  await draw();

  async function draw() {
    clear(page);
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    const [keep, c, status, reports, files, members] = await Promise.all([
      getSetting(SETTING_KEEP_FILES, true), counts(), moduleStatus(), listReports(), listFileMeta(), listMembers(),
    ]);
    append(page,
      el('div', { class: 'page-title' }, el('h1', 'Settings'), el('span', { class: 'muted small' }, `${c.reports} reports · ${c.members} members · ${c.files} stored PDFs`)),
      driveCard(),
      backupCard(),
      storageCard(keep, c, files),
      parserCard(status, reports, files),
      diagnosticCard(reports, files, members, status),
      assistCard(),
      aboutCard(status),
    );
  }

  // ---------- Google Drive sync ----------
  function driveCard() {
    const s0 = getSyncStatus();
    const statusChip = chip('', 'muted');
    const statusLine = el('p', { class: 'small text-2' });
    const clientInput = el('input', { type: 'text', placeholder: '123456789012-xxxxxxxx.apps.googleusercontent.com', 'aria-label': 'Google OAuth Client ID', spellcheck: 'false', autocomplete: 'off', value: s0.clientIdSource === 'settings' ? s0.clientId : '' });
    clientInput.style.flex = '1 1 320px';
    clientInput.style.fontFamily = 'var(--mono)';
    const eraseLocal = el('input', { type: 'checkbox' });
    const eraseRemote = el('input', { type: 'checkbox' });
    const busy = el('span', { class: 'muted small' });

    const connectBtn = button('Connect Google Drive', async () => {
      connectBtn.disabled = true; busy.textContent = 'Waiting for Google…';
      const r = await connect();
      busy.textContent = '';
      connectBtn.disabled = false;
      if (r && r.ok) toast(r.message || 'Connected and synced');
      else toast(r && r.message ? r.message : 'Could not connect', 4000);
      refresh();
    }, { kind: 'primary' });
    const syncBtn = button('Sync now', async () => {
      syncBtn.disabled = true;
      const r = await syncNow('manual');
      syncBtn.disabled = false;
      toast(r && r.message ? r.message : (r && r.ok ? 'Synced' : 'Sync failed'), 3500);
      if (r && r.changedLocal) await draw(); else refresh();
    });
    const disconnectBtn = button('Disconnect', async () => {
      const parts = ['Disconnect Google Drive on this device?'];
      if (eraseRemote.checked) parts.push('The app folder in your Google Drive will be DELETED (other devices will stop receiving updates).');
      if (eraseLocal.checked) parts.push('All reports, members and PDFs on THIS device will be erased.');
      if (!confirm(parts.join('\n'))) return;
      if ((eraseRemote.checked || eraseLocal.checked) && !confirm('Really erase? Export a backup first if you are not sure.')) return;
      disconnectBtn.disabled = true;
      const r = await disconnect({ eraseRemote: eraseRemote.checked, eraseLocal: eraseLocal.checked });
      toast(r.message, 4000);
      await draw();
    }, { kind: 'danger' });
    const saveIdBtn = button('Save Client ID', async () => {
      const v = clientInput.value.trim();
      if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Google OAuth Client ID (…apps.googleusercontent.com)'); return; }
      await setClientId(v);
      toast(v ? 'Client ID saved' : (configClientId() ? 'Using the built-in Client ID' : 'Client ID cleared'));
      refresh();
    }, { small: true });

    function refresh() {
      const s = getSyncStatus();
      const kind = s.status === 'synced' ? 'good' : s.status === 'error' ? 'critical' : (s.status === 'needs-auth' || s.status === 'offline') ? 'warning' : s.status === 'not-connected' ? 'muted' : 'accent';
      statusChip.className = `chip chip-${kind}`;
      statusChip.textContent = s.status === 'not-connected' ? 'not connected' : s.status === 'needs-auth' ? 'sign in needed' : s.status === 'idle' ? 'connected' : s.status;
      clear(statusLine);
      if (s.status === 'not-connected') statusLine.textContent = s.message ? `Not connected. ${s.message}` : 'Not connected. Nothing is sent anywhere until you connect.';
      else {
        statusLine.append(`Connected to Google Drive. Last sync: ${s.lastSyncAt ? `${fmtDate(s.lastSyncAt.slice(0, 16))} (${relTime(s.lastSyncAt)})` : 'never'}.`);
        if (s.message && s.status !== 'synced') statusLine.append(' ', el('span', { class: s.status === 'error' ? 'chip chip-critical' : 'chip chip-warning' }, s.message));
        else if (s.notice) statusLine.append(' ', el('span', { class: 'chip chip-warning' }, s.notice));
      }
      connectBtn.textContent = s.connected ? 'Sign in again' : 'Connect Google Drive';
      connectBtn.disabled = !s.clientId || !s.available;
      connectBtn.title = !s.clientId ? 'Paste a Google OAuth Client ID first' : null;
      connectBtn.classList.toggle('hidden', s.connected && s.status !== 'needs-auth' && s.status !== 'error');
      syncBtn.classList.toggle('hidden', !s.connected);
      syncBtn.disabled = s.status === 'syncing';
      disconnectBtn.classList.toggle('hidden', !s.connected);
      eraseLocal.parentElement && eraseLocal.parentElement.classList.toggle('hidden', !s.connected);
      eraseRemote.parentElement && eraseRemote.parentElement.classList.toggle('hidden', !s.connected);
    }
    unsubscribe = onSyncStatus(refresh);
    refresh();

    const idHint = s0.clientIdSource === 'config'
      ? 'A Client ID is built into this deployment; paste a different one here only if you set up your own Google project.'
      : s0.clientIdSource === 'settings' ? 'Using the Client ID saved on this device.' : 'No Client ID yet: follow docs/GOOGLE-DRIVE-SETUP.md once, then paste the Client ID here.';

    return el('section', { class: 'card', id: 'drive-sync' },
      el('div', { class: 'card-head' }, el('h2', 'Google Drive sync'), statusChip),
      el('p', { class: 'text-2 small' }, 'Keeps the same family data on every device that opens this app and signs in with the same Google account. Members, report records (parsed results, your edits, member assignments) are stored as one JSON file, and each saved PDF as its own file, in a hidden app folder of that account\'s Google Drive. Google hides this folder from the Drive website and other apps; only this app can read it. The app asks for one permission only (', el('code', DRIVE_SCOPE.replace('https://www.googleapis.com/auth/', '')), '), which cannot see any of your other Drive files. Nothing is uploaded until you connect, and the app keeps working offline or signed out.'),
      statusLine,
      el('div', { class: 'toolbar' }, connectBtn, syncBtn, el('span', { class: 'spacer' }), disconnectBtn, busy),
      el('div', { class: 'row small' },
        el('label', { class: 'check small' }, eraseLocal, 'also erase local data on this device'),
        el('label', { class: 'check small' }, eraseRemote, 'also delete the data in Drive')),
      el('details', { class: 'panel', style: { marginTop: '10px' }, open: !s0.clientId },
        el('summary', { class: 'small' }, 'Google OAuth Client ID'),
        el('div', { class: 'body' },
          el('p', { class: 'muted small' }, idHint),
          el('div', { class: 'row' }, clientInput, saveIdBtn),
          el('p', { class: 'muted small', style: { marginTop: '6px' } }, 'The Client ID is not a secret and is not included in backups. Everyone who should see the family data signs in with the same Google account.'))));
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
        requestSync('backup-import');
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
            download(`family-health-backup-${todayIso()}.json`, JSON.stringify(obj), 'application/json');
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
          if (!confirm(`Delete ALL ${c.reports} reports, ${c.members} members and ${c.files} PDFs from this browser? This cannot be undone.${getSyncStatus().connected ? ' Drive sync is disconnected on this device; data already in Drive stays there.' : ''}`)) return;
          if (!confirm('Really delete everything? Export a backup first if you are not sure.')) return;
          // Through the sync module so the connection flag, the in-memory token and the pill are reset as well;
          // a bare db.clearAll() would leave the engine "connected" and the next trigger would re-pull from Drive.
          await disconnect({ eraseLocal: true });
          toast('All data cleared on this device');
          await draw();
        }, { kind: 'danger' })));
  }

  function parserCard(status, reports, files) {
    const fileIds = new Set(files.map((f) => f.id).concat(remoteFileIds()));
    const stale = reports.filter((r) => status.parserVersion && r.report?.source?.parserVersion !== status.parserVersion);
    const reparsable = reports.filter((r) => fileIds.has(r.id));
    const log = el('ul', { class: 'progress' });
    const run = button(`Re-parse all stored PDFs (${reparsable.length})`, async () => {
      if (!reparsable.length) { toast('No stored PDFs to re-parse'); return; }
      run.disabled = true;
      clear(log);
      let ok = 0, failed = 0, orphans = 0;
      for (const rec of reparsable) {
        const li = el('li', el('span', { class: 'spinner' }), el('span', { class: 'fn' }, rec.report?.source?.fileName || rec.id), el('span', { class: 'muted small status' }, 'parsing…'));
        log.appendChild(li);
        try {
          // Rekey any legacy id-based overrides against the OLD report before it is replaced, so an edit
          // stays attached to the analyte it was made on even if result ids shift in the new parse.
          migrateOverrides(rec, rec.report);
          const f = await ensureFileBytes(rec.id, { fileName: rec.report?.source?.fileName || null });
          if (!f) throw new Error('PDF not available on this device or in Drive');
          const { report, error } = await extractAndParse(f.bytes, f.fileName || rec.report?.source?.fileName || 'report.pdf');
          if (!report) throw error || new Error('no report');
          const { orphaned } = resolveOverrides(rec, report);
          await putReport({ ...rec, report, orphanedOverrides: orphaned });
          ok++; orphans += orphaned.length;
          li.querySelector('.spinner').replaceWith(el('span', '✓'));
          const status = clear(li.querySelector('.status'));
          append(status, chip(report.audit?.label || 'parsed', report.audit?.label || 'muted'), ` ${report.results?.length || 0} results · parser ${report.source?.parserVersion || '?'}`,
            orphaned.length ? el('span', ' ', chip(`${orphaned.length} edit${orphaned.length === 1 ? '' : 's'} not re-applied`, 'warning', orphaned.map((o) => `${o.name} → ${o.value}`).join('; ')), ' ', el('a', { href: `#/review/${encodeURIComponent(rec.id)}` }, 'review')) : null);
        } catch (err) {
          failed++;
          li.querySelector('.spinner').replaceWith(el('span', '⚠'));
          li.querySelector('.status').textContent = `failed: ${err.message || err}`;
        }
      }
      toast(`Re-parsed ${ok}${failed ? `, ${failed} failed` : ''}${orphans ? `; ${orphans} edit${orphans === 1 ? '' : 's'} could not be re-applied` : ''}`);
      if (ok) requestSync('reparse');
      run.disabled = false;
    }, { disabled: !hasPdfjs() || !status.parser || !status.extractor });
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', 'Parser'), chip(status.parserVersion ? `v${status.parserVersion}` : 'unavailable', status.parserVersion ? 'accent' : 'critical')),
      el('p', { class: 'text-2 small' }, stale.length ? `${stale.length} stored report${stale.length === 1 ? ' was' : 's were'} parsed with an older parser version. Your edits and member assignments are kept when re-parsing; edits are matched to results by source line and test name, and any that cannot be re-applied are flagged on the report's Review page.` : 'All stored reports are up to date with the current parser.'),
      el('div', { class: 'toolbar' }, run),
      log);
  }

  function diagnosticCard(reports, files, members, status) {
    const fileIds = new Set(files.map((f) => f.id).concat(remoteFileIds()));
    const opts = reports.map((r) => ({ value: r.id, label: `${fmtDate(r.report?.specimen?.collectedAt, { time: false }) || 'no date'} · ${vendorLabel(r.report?.source?.vendor)} · ${members.find((m) => m.id === r.memberId)?.name || 'unassigned'} · ${r.report?.source?.fileName || r.id}${fileIds.has(r.id) ? '' : ' (no stored PDF)'}` }));
    const sel = select({ placeholder: reports.length ? '— choose report —' : 'No stored reports', options: opts });
    const out = el('textarea', { rows: 10, readonly: true, placeholder: 'Redacted diagnostic text appears here.' });
    out.classList.add('hidden');
    const go = button('Copy redacted diagnostic', async () => {
      const rec = reports.find((r) => r.id === sel.value);
      if (!rec) { toast('Choose a report'); return; }
      if (!fileIds.has(rec.id)) { toast('This report has no stored PDF; the diagnostic needs the extracted text.'); return; }
      try {
        const f = await ensureFileBytes(rec.id, { fileName: rec.report?.source?.fileName || null });
        if (!f) throw new Error('PDF not available on this device or in Drive');
        const { doc, error } = await extractAndParse(f.bytes, f.fileName || 'report.pdf');
        if (!doc) throw error || new Error('extraction failed');
        await getAnalytesModule();
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
      el('p', { class: 'text-2 small' }, 'Family Health runs in your browser. Lab PDFs are parsed with deterministic rules on this device. Nothing is uploaded unless you connect Google Drive sync, and then only to the hidden app folder of the Google account you sign in with. pdf.js (4.10.38) and, after you connect, the Google sign-in library are the only remote code loaded.'),
      el('ul', { class: 'members small' },
        row('pdf.js engine', status.pdfjs, status.pdfjsError),
        row('PDF extractor', status.extractor, status.extractorError),
        row('Parser', status.parser, status.parserError),
        row('Analyte dictionary', status.analytes, status.analytesError),
        row('Redaction', status.redact, status.redactError)),
      el('p', { class: 'muted small' }, notice('Tip: if you clear this site\'s data in your browser, everything here is gone. Keep a backup.')));
  }

  return () => { if (unsubscribe) unsubscribe(); };
}
