// Small DOM helpers. No framework. All text goes through textContent (never innerHTML).

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') node.setAttribute('class', v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && 'value' in node) node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') {
      if (v) node.setAttribute(k, ''); node[k] = !!v;
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
}

function appendChildren(node, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) { appendChildren(node, c); continue; }
    if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

/** el('div', { class: 'x', onClick }, 'text', childNode, [more]) — attrs may be omitted. */
export function el(tag, attrs, ...children) {
  if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs) || typeof attrs === 'number') {
    children.unshift(attrs); attrs = null;
  }
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

export function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  appendChildren(node, children);
  return node;
}

export function clear(node) { node.replaceChildren(); return node; }

export function frag(...children) { const f = document.createDocumentFragment(); appendChildren(f, children); return f; }

/** Null-safe append: skips null/false children (ParentNode.append(null) would render "null"). */
export function append(parent, ...children) { appendChildren(parent, children); return parent; }

/** chip('found', 'found') → <span class="chip chip-found">found</span> */
export function chip(text, kind, title) {
  return el('span', { class: `chip${kind ? ' chip-' + kind : ''}`, title: title || null }, text);
}

const STATUS_ICON = { found: '✓', missing: '✕', uncertain: '?', na: '–', edited: '✎' };
const STATUS_LABEL = { na: 'n/a' };
const STATUS_TITLE = { na: 'Not printed on this report (optional field)' };
export function statusChip(status) {
  const s = status || 'missing';
  return el('span', { class: `chip chip-${s}`, title: STATUS_TITLE[s] || `Field status: ${s}` }, el('span', { class: 'ico', 'aria-hidden': 'true' }, STATUS_ICON[s] || ''), STATUS_LABEL[s] || s);
}

export function labelChip(label) {
  const l = label || 'incomplete';
  const icon = l === 'complete' ? '✓' : l === 'review' ? '!' : '✕';
  return el('span', { class: `chip chip-${l}` }, el('span', { class: 'ico', 'aria-hidden': 'true' }, icon), l);
}

export function flagChip(flag) {
  if (!flag) return el('span', { class: 'muted' }, '');
  const words = { H: 'High', L: 'Low', HH: 'Critical high', LL: 'Critical low', A: 'Abnormal', C: 'Critical' };
  return el('span', { class: `chip chip-flag-${flag}`, title: words[flag] || flag }, flag);
}

export const VENDOR_LABEL = { labcorp: 'Labcorp', quest: 'Quest', unknown: 'Other' };
export function vendorKey(v) { return v === 'labcorp' || v === 'quest' ? v : 'other'; }
export function vendorLabel(v) { return VENDOR_LABEL[v] || (v ? String(v) : 'Other'); }
export function vendorChip(v, extra) {
  return el('span', { class: 'chip', title: extra || null }, el('span', { class: `vendor-dot ${vendorKey(v)}`, 'aria-hidden': 'true' }), vendorLabel(v));
}

/** Confidence bar 0..1 with numeric label. */
export function confidenceBar(c) {
  const n = typeof c === 'number' && isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
  const cls = n >= 0.8 ? '' : n >= 0.5 ? ' mid' : ' low';
  const fill = el('i');
  fill.style.width = `${Math.round(n * 100)}%`;
  return el('span', { class: 'conf', title: `confidence ${pct(n)}` }, el('span', { class: `conf-bar${cls}` }, fill), pct(n));
}

/** Parse 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' as local wall time. No timezone shifting. */
export function parseLocalDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  return isNaN(d.getTime()) ? null : d;
}

export function hasTime(iso) { return typeof iso === 'string' && /T\d{2}:\d{2}/.test(iso); }

/** Local display of an ISO wall-time string. */
export function fmtDate(iso, opts = {}) {
  if (iso == null || iso === '') return '';
  const d = parseLocalDate(iso);
  if (!d) return String(iso);
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (opts.time === false || !hasTime(iso)) return date;
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} ${t}`;
}

export function fmtShortDate(iso) {
  const d = parseLocalDate(iso);
  if (!d) return iso ? String(iso) : '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtNum(n, digits) {
  if (n == null || !isFinite(n)) return '';
  if (digits != null) return n.toFixed(digits);
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 100) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function pct(n) { return `${Math.round((n || 0) * 100)}%`; }

export function button(label, onClick, opts = {}) {
  const b = el('button', { type: 'button', class: ['', opts.kind ? 'btn-' + opts.kind : '', opts.small ? 'btn-small' : '', opts.class || ''].join(' ').trim() || null, disabled: !!opts.disabled, title: opts.title || null }, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** select({ options:[{value,label}], value, onChange, placeholder, id }) */
export function select({ options = [], value = '', onChange, placeholder, id, disabled } = {}) {
  const s = el('select', { id: id || null, disabled: !!disabled });
  if (placeholder != null) s.appendChild(el('option', { value: '' }, placeholder));
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    s.appendChild(opt);
  }
  if (placeholder != null && (value == null || value === '')) s.value = '';
  if (onChange) s.addEventListener('change', () => onChange(s.value, s));
  return s;
}

export function field(label, control) {
  return el('label', { class: 'field' }, el('span', label), control);
}

export function section(title, ...children) {
  return el('section', { class: 'card' }, title ? el('h2', title) : null, ...children);
}

export function emptyState(msg, action) {
  return el('div', { class: 'empty' }, el('p', msg), action || null);
}

export function notice(msg, kind) {
  return el('div', { class: `notice${kind ? ' ' + kind : ''}` }, msg);
}

/**
 * table({ head: ['A','B'], rows: [ { cells: [..], class, onClick } | [..] ], numeric: [1,2] })
 * Cells may be strings, numbers, or Nodes.
 */
export function table({ head = [], rows = [], numeric = [], classes = '' } = {}) {
  const thead = el('thead', el('tr', head.map((h, i) => el('th', { class: numeric.includes(i) ? 'num' : null, scope: 'col' }, h))));
  const tbody = el('tbody');
  for (const r of rows) {
    const row = Array.isArray(r) ? { cells: r } : r;
    const tr = el('tr', { class: row.class || null });
    if (row.span) {
      tr.appendChild(el('td', { colspan: head.length }, ...(Array.isArray(row.span) ? row.span : [row.span])));
    } else {
      row.cells.forEach((c, i) => tr.appendChild(el('td', { class: numeric.includes(i) ? 'num' : null }, c)));
    }
    if (row.onClick) { tr.classList.add('clickable'); tr.addEventListener('click', row.onClick); }
    tbody.appendChild(tr);
  }
  return el('div', { class: 'table-wrap' }, el('table', { class: `tbl ${classes}`.trim() }, thead, tbody));
}

/** Client-side download of text/blob. */
export function download(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

export function toCSV(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function debounce(fn, ms = 120) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Shorten a sha256-like id for display. */
export function shortId(id) { return id ? String(id).slice(0, 8) : ''; }

export function errorBox(err, title = 'Something went wrong') {
  const msg = err && err.message ? err.message : String(err);
  return el('div', { class: 'notice error' }, el('strong', title), el('br'), msg);
}

/** Copy text to clipboard with a textarea fallback. Returns true on success. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = el('textarea', { value: text, readonly: true });
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}
