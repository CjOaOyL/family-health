// Line reconstruction from pdf.js text items. Pure and isomorphic. See docs/SPEC.md §2.
//
// buildLines(textItems, pageWidth, pageHeight, pageNumber) accepts either raw pdf.js
// getTextContent() items ({ str, transform, width, height, fontName }) or already-converted
// TextItem objects ({ str, x, y, w, h, font? }) so fixtures and tests can run without pdf.js.

/** Minimum vertical tolerance (PDF units) for two items to share a line. */
export const LINE_Y_TOLERANCE_MIN = 2;
/** Vertical tolerance as a fraction of item height. */
export const LINE_Y_TOLERANCE_FACTOR = 0.45;
/** Gaps smaller than this fraction of the average char width are joined with no space. */
export const GAP_JOIN_FACTOR = 0.25;
/** Minimum gap (PDF units) that starts a new column cell. */
export const GAP_CELL_MIN = 6;
/** Cell gap as a multiple of the average char width. */
export const GAP_CELL_FACTOR = 1.8;
/** When pdf.js reports width 0, estimate w = str.length * h * CHAR_WIDTH_ESTIMATE. */
export const CHAR_WIDTH_ESTIMATE = 0.5;
/** Height used when an item reports neither a usable transform scale nor a height. */
export const DEFAULT_ITEM_HEIGHT = 10;

const round2 = (n) => Math.round(n * 100) / 100;

/** Vertical tolerance for grouping two items (uses the taller of the two). */
export function lineTolerance(ha, hb = ha) {
  return Math.max(LINE_Y_TOLERANCE_MIN, LINE_Y_TOLERANCE_FACTOR * Math.max(ha || 0, hb || 0));
}

/** GAP_CELL = max(6, 1.8 * cw) in PDF units. */
export function cellGap(cw) {
  return Math.max(GAP_CELL_MIN, GAP_CELL_FACTOR * cw);
}

/** Average character width of an item. */
export function charWidth(item) {
  return item.w / Math.max(1, item.str.length);
}

/**
 * Convert one pdf.js text item (or a pre-converted TextItem) to a top-origin TextItem.
 * Returns null for items with blank text.
 * `origin` = { x, y } of the page's lower-left corner in user space (page.view[0], page.view[1]).
 */
export function toTextItem(item, pageHeight, origin = { x: 0, y: 0 }) {
  if (!item || typeof item.str !== 'string' || item.str.trim() === '') return null;
  const str = item.str;
  let x, y, w, h;
  if (Array.isArray(item.transform) && item.transform.length >= 6) {
    const tx = item.transform;
    x = tx[4] - (origin.x || 0);
    y = pageHeight - (tx[5] - (origin.y || 0));
    // Unrotated text: tx = [scaleX, 0, 0, scaleY, e, f]. Rotated transforms are rare; use the
    // vector length of the second column as the font height in that case.
    if (tx[1] === 0 && tx[2] === 0) h = Math.abs(tx[3]);
    else h = Math.hypot(tx[2], tx[3]);
    if (!h) h = Math.abs(item.height) || 0;
    w = Math.abs(item.width) || 0;
  } else {
    x = Number(item.x) || 0;
    y = Number(item.y) || 0;
    h = Math.abs(Number(item.h)) || Math.abs(Number(item.height)) || 0;
    w = Math.abs(Number(item.w)) || Math.abs(Number(item.width)) || 0;
  }
  if (!h) h = DEFAULT_ITEM_HEIGHT;
  if (!w) w = str.length * h * CHAR_WIDTH_ESTIMATE;
  const out = { str, x: round2(x), y: round2(y), w: round2(w), h: round2(h) };
  const font = item.font ?? item.fontName;
  if (font) out.font = font;
  return out;
}

/** Stable sort helper (Array.prototype.sort is stable in modern engines, but keep the tie-break explicit). */
function sortBy(arr, keyFns) {
  return arr
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      for (const k of keyFns) {
        const d = k(a.v) - k(b.v);
        if (d !== 0) return d;
      }
      return a.i - b.i;
    })
    .map((e) => e.v);
}

/** Group converted items into lines using the §2 y-tolerance rule. Returns arrays of items. */
export function groupIntoLines(items) {
  const sorted = sortBy(items, [(it) => it.y, (it) => it.x]);
  const groups = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.anchor.y) <= lineTolerance(cur.anchor.h, it.h)) {
      cur.items.push(it);
    } else {
      cur = { anchor: it, items: [it] };
      groups.push(cur);
    }
  }
  return groups.map((g) => g.items);
}

/** Join two text fragments with a separator, avoiding doubled spaces. */
function joinText(a, sep, b) {
  if (sep === '') return a + b;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  return a + sep + b;
}

/**
 * Build one Line from a group of items (already on the same baseline).
 * Applies the gap rules: gap < 0.25*cw → "", gap < GAP_CELL → " ", else new cell.
 */
export function buildLine(groupItems, pageNumber, index) {
  const items = sortBy(groupItems, [(it) => it.x]);
  const cells = [];
  const cellX = [];
  let cellText = '';
  let prev = null;
  for (const it of items) {
    if (!prev) {
      cellText = it.str;
      cellX.push(it.x);
    } else {
      const gap = it.x - (prev.x + prev.w);
      const cw = charWidth(prev);
      if (gap < GAP_JOIN_FACTOR * cw) {
        cellText = joinText(cellText, '', it.str);
      } else if (gap < cellGap(cw)) {
        cellText = joinText(cellText, ' ', it.str);
      } else {
        cells.push(cellText);
        cellText = it.str;
        cellX.push(it.x);
      }
    }
    prev = it;
  }
  cells.push(cellText);
  // Normalize whitespace inside each cell; drop cells that became empty.
  const normCells = [];
  const normCellX = [];
  cells.forEach((c, i) => {
    const t = c.replace(/\s+/g, ' ').trim();
    if (t) { normCells.push(t); normCellX.push(round2(cellX[i])); }
  });
  const ys = items.map((it) => it.y);
  const y = round2(ys.reduce((a, b) => a + b, 0) / ys.length);
  const x0 = round2(Math.min(...items.map((it) => it.x)));
  const x1 = round2(Math.max(...items.map((it) => it.x + it.w)));
  return {
    id: `p${pageNumber}l${index}`,
    page: pageNumber,
    y,
    x0,
    x1,
    text: normCells.join('  '),
    cells: normCells,
    cellX: normCellX,
    items,
  };
}

/**
 * buildLines(textItems, pageWidth, pageHeight, pageNumber = 1, opts?) → Line[]
 * opts.origin = { x, y }: lower-left corner of the page box in user space (defaults to 0,0).
 * pageWidth is accepted for signature symmetry and future use (clipping); it is not needed for the rules.
 */
export function buildLines(textItems, pageWidth, pageHeight, pageNumber = 1, opts = {}) {
  const origin = opts.origin || { x: 0, y: 0 };
  const ph = Number(pageHeight) || 0;
  const items = [];
  for (const raw of textItems || []) {
    const it = toTextItem(raw, ph, origin);
    if (it) items.push(it);
  }
  const groups = groupIntoLines(items);
  return groups.map((g, i) => buildLine(g, pageNumber, i));
}

/** Convenience: build a full Page object. */
export function buildPage(textItems, pageWidth, pageHeight, pageNumber, opts = {}) {
  return {
    pageNumber,
    width: round2(Number(pageWidth) || 0),
    height: round2(Number(pageHeight) || 0),
    lines: buildLines(textItems, pageWidth, pageHeight, pageNumber, opts),
  };
}
