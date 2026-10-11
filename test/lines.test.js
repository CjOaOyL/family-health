import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLines, buildPage, toTextItem, cellGap, lineTolerance,
  GAP_CELL_MIN, GAP_CELL_FACTOR, GAP_JOIN_FACTOR, LINE_Y_TOLERANCE_MIN, LINE_Y_TOLERANCE_FACTOR, CHAR_WIDTH_ESTIMATE,
} from '../src/pdf/lines.js';

const H = 792;
/** pdf.js-style item: baseline at PDF y (bottom origin). */
const pdfItem = (str, x, yTop, w, h = 10, extra = {}) => ({ str, transform: [h, 0, 0, h, x, H - yTop], width: w, height: h, fontName: 'f1', ...extra });

test('constants match SPEC §2', () => {
  assert.equal(LINE_Y_TOLERANCE_MIN, 2);
  assert.equal(LINE_Y_TOLERANCE_FACTOR, 0.45);
  assert.equal(GAP_JOIN_FACTOR, 0.25);
  assert.equal(GAP_CELL_MIN, 6);
  assert.equal(GAP_CELL_FACTOR, 1.8);
  assert.equal(cellGap(1), 6);               // max(6, 1.8)
  assert.equal(cellGap(5), 9);               // 1.8 * 5
  assert.equal(lineTolerance(10), 4.5);
  assert.equal(lineTolerance(2), 2);         // floor at 2
});

test('toTextItem converts pdf.js transforms to top-origin coordinates', () => {
  const it = toTextItem({ str: 'Glucose', transform: [9, 0, 0, 9, 50, 700], width: 30, height: 9, fontName: 'g' }, H);
  assert.deepEqual(it, { str: 'Glucose', x: 50, y: 92, w: 30, h: 9, font: 'g' });
});

test('toTextItem drops blank items and estimates zero widths', () => {
  assert.equal(toTextItem({ str: '   ', transform: [9, 0, 0, 9, 0, 0], width: 5 }, H), null);
  assert.equal(toTextItem({ str: '', transform: [9, 0, 0, 9, 0, 0], width: 5 }, H), null);
  const it = toTextItem({ str: 'abcd', transform: [8, 0, 0, 8, 10, 700], width: 0, height: 8 }, H);
  assert.equal(it.w, 4 * 8 * CHAR_WIDTH_ESTIMATE);
});

test('toTextItem uses item.height when the transform scale is zero and handles rotated transforms', () => {
  const a = toTextItem({ str: 'x', transform: [0, 0, 0, 0, 10, 700], width: 5, height: 7 }, H);
  assert.equal(a.h, 7);
  const b = toTextItem({ str: 'rot', transform: [0, 9, -9, 0, 10, 700], width: 12, height: 9 }, H);
  assert.equal(b.h, 9);
});

test('toTextItem accepts already-converted TextItem objects', () => {
  const it = toTextItem({ str: 'A', x: 1.004, y: 2, w: 3, h: 4 }, H);
  assert.deepEqual(it, { str: 'A', x: 1, y: 2, w: 3, h: 4 });
  const est = toTextItem({ str: 'AB', x: 1, y: 2, h: 10 }, H);
  assert.equal(est.w, 10); // 2 chars * 10 * 0.5
});

test('groups items into lines by y tolerance and sorts top-to-bottom, left-to-right', () => {
  const items = [
    pdfItem('mg/dL', 300, 200.5, 25),
    pdfItem('Glucose', 40, 200, 35),
    pdfItem('95', 200, 199.2, 10),
    pdfItem('Lipid Panel', 40, 180, 50),
    pdfItem('65-99', 400, 200, 25),
  ];
  const lines = buildLines(items, 612, H, 1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 'p1l0');
  assert.equal(lines[0].text, 'Lipid Panel');
  assert.equal(lines[1].id, 'p1l1');
  assert.deepEqual(lines[1].cells, ['Glucose', '95', 'mg/dL', '65-99']);
  assert.deepEqual(lines[1].cellX, [40, 200, 300, 400]);
  assert.equal(lines[1].text, 'Glucose  95  mg/dL  65-99');
  assert.equal(lines[1].x0, 40);
  assert.equal(lines[1].x1, 425);
  assert.equal(lines[1].page, 1);
  assert.deepEqual(lines[1].items.map((i) => i.str), ['Glucose', '95', 'mg/dL', '65-99']);
});

test('items further apart than the tolerance form separate lines', () => {
  const items = [pdfItem('a', 10, 100, 5, 10), pdfItem('b', 10, 105, 5, 10)]; // 5 > 4.5
  const lines = buildLines(items, 612, H, 3);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.id), ['p3l0', 'p3l1']);
  const close = [pdfItem('a', 10, 100, 5, 10), pdfItem('b', 20, 104, 5, 10)]; // 4 <= 4.5
  assert.equal(buildLines(close, 612, H, 1).length, 1);
});

test('gap rules: tiny gap joins with nothing, medium gap with a space, large gap starts a new cell', () => {
  // "Chol" w=20 (cw=5). gap 1 (<1.25) → "", gap 4 (<9) → " ", gap 9 (>=9) → new cell
  const items = [
    pdfItem('Chol', 10, 100, 20),
    pdfItem('esterol,', 31, 100, 40),       // gap 1
    pdfItem('Total', 75, 100, 25),          // gap 4
    pdfItem('210', 109, 100, 15),           // gap 9 → new cell
  ];
  const [line] = buildLines(items, 612, H, 1);
  assert.deepEqual(line.cells, ['Cholesterol, Total', '210']);
  assert.equal(line.text, 'Cholesterol, Total  210');
});

test('overlapping items (negative gap) are joined without a space', () => {
  const items = [pdfItem('Hemo', 10, 100, 20), pdfItem('globin', 29, 100, 30)];
  const [line] = buildLines(items, 612, H, 1);
  assert.equal(line.text, 'Hemoglobin');
});

test('GAP_CELL scales with the average char width', () => {
  // cw = 8 → GAP_CELL = 14.4; a gap of 12 is still a space, 15 starts a new cell
  const a = buildLines([pdfItem('ab', 0, 100, 16), pdfItem('cd', 28, 100, 16)], 612, H, 1)[0];
  assert.deepEqual(a.cells, ['ab cd']);
  const b = buildLines([pdfItem('ab', 0, 100, 16), pdfItem('cd', 31, 100, 16)], 612, H, 1)[0];
  assert.deepEqual(b.cells, ['ab', 'cd']);
});

test('whitespace inside items is normalized and does not double up', () => {
  const items = [pdfItem('Patient ', 0, 100, 40), pdfItem(' Report', 42, 100, 35)];
  const [line] = buildLines(items, 612, H, 1);
  assert.equal(line.text, 'Patient Report');
});

test('sort is stable for identical coordinates', () => {
  const items = [pdfItem('b', 10, 100, 0), pdfItem('a', 10, 100, 0)];
  const [line] = buildLines(items, 612, H, 1);
  assert.equal(line.text, 'ba');
});

test('empty input yields no lines; buildPage returns a Page', () => {
  assert.deepEqual(buildLines([], 612, H, 1), []);
  const page = buildPage([pdfItem('x', 1, 1, 1)], 612, H, 2);
  assert.equal(page.pageNumber, 2);
  assert.equal(page.width, 612);
  assert.equal(page.height, 792);
  assert.equal(page.lines[0].id, 'p2l0');
});

test('origin offset is applied when the page box does not start at 0,0', () => {
  const [line] = buildLines([{ str: 'x', transform: [10, 0, 0, 10, 60, 700], width: 5 }], 612, 792, 1, { origin: { x: 10, y: 8 } });
  assert.equal(line.x0, 50);
  assert.equal(line.y, 100); // 792 - (700 - 8)
});
