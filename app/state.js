// In-memory session state shared across views. Nothing here is persisted.

/**
 * Pending review records produced by Import (keyed by fileHash / id):
 * { id, fileName, bytes: ArrayBuffer, doc: Document|null, report: LabReport|null, error: Error|null,
 *   overrides: {}, memberId: string|null, parserVersion, stored: boolean, importedAt }
 */
export const session = {
  pending: new Map(),
  queue: [],            // ids awaiting review, in import order
  docs: new Map(),      // id → Document kept in memory for stored reports re-extracted this session
};

export function addPending(rec) {
  session.pending.set(rec.id, rec);
  if (!session.queue.includes(rec.id)) session.queue.push(rec.id);
  notify();
}

export function removePending(id) {
  session.pending.delete(id);
  session.queue = session.queue.filter((x) => x !== id);
  notify();
}

export function nextPending(afterId) {
  const q = session.queue.filter((x) => x !== afterId);
  return q.length ? q[0] : null;
}

export function pendingCount() { return session.queue.length; }

const listeners = new Set();
export function onSessionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/** Parse the hash into { name, id, query }. */
export function parseHash(hash = location.hash) {
  let h = (hash || '').replace(/^#\/?/, '');
  let query = {};
  const qi = h.indexOf('?');
  if (qi >= 0) {
    const qs = h.slice(qi + 1); h = h.slice(0, qi);
    try { for (const [k, v] of new URLSearchParams(qs)) query[k] = v; } catch { query = {}; }
  }
  const parts = h.split('/').filter(Boolean);
  let id = null;
  if (parts[1]) {
    // A malformed escape (e.g. "#/review/%E0") must not throw out of the router and blank the app.
    try { id = decodeURIComponent(parts[1]); } catch { id = parts[1]; }
  }
  return { name: parts[0] || 'import', id, query };
}

export function hashFor(name, id, query) {
  let h = `#/${name}${id ? '/' + encodeURIComponent(id) : ''}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') qs.set(k, v);
    const s = qs.toString();
    if (s) h += '?' + s;
  }
  return h;
}
