// Import view: drop/choose PDFs → extract + parse in the browser → Review.
import { el, clear, append, button, notice, chip, toast, vendorChip, pct } from '../ui.js';
import { extractAndParse, hasPdfjs, pdfjsProblem, sha256Hex, getParserVersion } from '../pipeline.js';
import { addPending, session, navigate, hashFor } from '../state.js';
import { getReport } from '../../src/store/db.js';

export const title = 'Import';

export async function render(root, { query }) {
  const items = el('ul', { class: 'progress' });
  const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true });
  const busy = { on: false };

  const drop = el('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Choose or drop PDF files' },
    el('p', el('strong', 'Drop lab report PDFs here')),
    el('p', { class: 'text-2' }, 'or'),
    button('Choose PDFs', () => input.click(), { kind: 'primary' }),
    input,
    el('p', { class: 'privacy' }, 'Your PDF never leaves this device.'));

  drop.addEventListener('click', (e) => { if (e.target === drop || e.target.tagName === 'P' || e.target.tagName === 'STRONG') input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => { const files = Array.from(e.dataTransfer?.files || []); if (files.length) processFiles(files); });
  input.addEventListener('change', () => { const files = Array.from(input.files || []); input.value = ''; if (files.length) processFiles(files); });

  const engineNote = hasPdfjs()
    ? null
    : notice(`The PDF engine (pdf.js) did not load${pdfjsProblem() ? ': ' + pdfjsProblem() : ''}. Import needs it; stored reports still work. Check your connection and reload.`, 'error');

  const pendingList = renderPending();

  append(root, 
    el('div', { class: 'page-title' }, el('h1', 'Import lab reports'), el('span', { class: 'muted small' }, 'Labcorp and Quest PDFs, parsed locally')),
    engineNote,
    drop,
    el('section', { class: 'card' }, el('h2', 'Progress'), items),
    pendingList,
  );

  async function processFiles(files) {
    if (busy.on) { toast('Still working on the previous batch'); return; }
    busy.on = true;
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) { toast('No PDF files selected'); busy.on = false; return; }
    const ids = [];
    for (const file of pdfs) {
      const li = el('li', el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { class: 'fn' }, file.name), el('span', { class: 'muted small status' }, 'reading…'));
      items.appendChild(li);
      const status = li.querySelector('.status');
      try {
        const bytes = await file.arrayBuffer();
        status.textContent = 'extracting text…';
        const { doc, report, error, parserVersion } = await extractAndParse(bytes, file.name);
        const id = doc?.fileHash || report?.id || (await sha256Hex(bytes));
        const existing = await getReport(id).catch(() => null);
        const rec = {
          id, fileName: file.name, bytes, doc, report, error,
          overrides: existing?.overrides ? { ...existing.overrides } : {},
          memberId: existing?.memberId ?? null,
          parserVersion: parserVersion || (await getParserVersion()),
          stored: !!existing,
          savedAt: existing?.savedAt || null,
          importedAt: new Date().toISOString(),
        };
        addPending(rec);
        ids.push(id);
        li.querySelector('.spinner').replaceWith(el('span', { 'aria-hidden': 'true' }, error ? '⚠' : '✓'));
        clear(status);
        if (error) {
          status.append(chip('error', 'critical'), ' ', error.message || String(error));
        } else {
          const a = report.audit;
          status.append(vendorChip(report.source?.vendor), ' ', chip(a ? `${pct(a.overall)} ${a.label}` : 'parsed', a ? a.label : 'muted'), ` ${report.results?.length || 0} results`);
          if (existing) status.append(' ', chip('already stored', 'accent', 'A report with this file hash is already saved; saving again will update it.'));
        }
        status.append(' ', el('a', { href: hashFor('review', id) }, 'Review'));
      } catch (err) {
        li.querySelector('.spinner').replaceWith(el('span', { 'aria-hidden': 'true' }, '⚠'));
        status.textContent = `failed: ${err.message || err}`;
      }
    }
    busy.on = false;
    if (ids.length) navigate(hashFor('review', ids[0]));
  }

  function renderPending() {
    const ids = session.queue;
    if (!ids.length) return null;
    const list = el('ul', { class: 'progress' });
    for (const id of ids) {
      const r = session.pending.get(id);
      if (!r) continue;
      list.appendChild(el('li',
        el('span', { class: 'fn' }, r.fileName),
        r.error ? chip('error', 'critical') : chip(r.report?.audit?.label || 'parsed', r.report?.audit?.label || 'muted'),
        el('a', { href: hashFor('review', id) }, 'Review')));
    }
    return el('section', { class: 'card' }, el('h2', 'Awaiting review'), el('p', { class: 'muted small' }, 'These are parsed in memory and not saved yet. Open each to check and save.'), list);
  }

  return () => { busy.on = false; };
}
