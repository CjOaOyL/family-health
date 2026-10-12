import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRange, parseValue, isTextValue, parseUSDate, expandTwoDigitYear, splitLabels, normalizeRangeText, isNARangeText,
} from '../src/parse/common.js';

// ---------------------------------------------------------------- parseRange

test('parseRange accepts bounds of any digit count (4-digit Quest absolutes, 1,250 with commas)', () => {
  for (const [s, lo, hi] of [['1500-7800', 1500, 7800], ['232-1245', 232, 1245], ['850-3900', 850, 3900], ['3.4-10.8', 3.4, 10.8],
    ['10,000-20,000', 10000, 20000], ['1,250-2,500', 1250, 2500], ['-2.0-3.0', -2, 3], ['0.450-4.500', 0.45, 4.5], ['0 - 5', 0, 5]]) {
    const r = parseRange(s);
    assert.equal(r.kind, 'range', s);
    assert.equal(r.low, lo, s); assert.equal(r.high, hi, s);
    assert.equal(r.text, s);
  }
});

test('parseRange handles unicode minus / en dash / em dash and "to"', () => {
  assert.deepEqual(parseRange('0.0 – 5.0'), { text: '0.0 – 5.0', low: 0, high: 5, kind: 'range' });
  assert.deepEqual(parseRange('4.5 − 11.0'), { text: '4.5 − 11.0', low: 4.5, high: 11, kind: 'range' });
  assert.deepEqual(parseRange('13 — 17'), { text: '13 — 17', low: 13, high: 17, kind: 'range' });
  assert.deepEqual(parseRange('65 to 99'), { text: '65 to 99', low: 65, high: 99, kind: 'range' });
});

test('parseRange understands the Quest "< OR =" / "> OR =" spelling and <=, >=, ≤, ≥', () => {
  assert.deepEqual(parseRange('< OR = 4.0'), { text: '< OR = 4.0', low: null, high: 4, kind: 'le' });
  assert.deepEqual(parseRange('> OR = 60'), { text: '> OR = 60', low: 60, high: null, kind: 'ge' });
  assert.equal(parseRange('> OR = 45 mg/dL').kind, 'ge');
  assert.equal(parseRange('<=5').kind, 'le');
  assert.equal(parseRange('>=60').kind, 'ge');
  assert.equal(parseRange('≤5').kind, 'le');
  assert.equal(parseRange('≥60').kind, 'ge');
  assert.deepEqual(parseRange('<200'), { text: '<200', low: null, high: 200, kind: 'lt' });
  assert.deepEqual(parseRange('>39'), { text: '>39', low: 39, high: null, kind: 'gt' });
  assert.equal(parseRange('<5.7 % of total Hgb').high, 5.7);
});

test('parseRange never treats titers as numeric', () => {
  for (const s of ['<1:80', '>1:640', '1:40', '< 1:10', '>=1:16']) {
    const r = parseRange(s);
    assert.equal(r.kind, 'text', s); assert.equal(r.low, null, s); assert.equal(r.high, null, s);
  }
});

test('parseRange keeps trailing units / parentheticals out of the bounds', () => {
  assert.equal(parseRange('0-1 /HPF').high, 1);
  assert.equal(parseRange('0-1 /HPF').low, 0);
  assert.equal(parseRange('70-99 (Fasting)').low, 70);
  assert.equal(parseRange('<130 (calc)').high, 130);
  assert.equal(parseRange('6.0-8.5 (see note)').high, 8.5);
  assert.equal(parseRange('3.8-10.8 Thousand/uL').high, 10.8);
});

test('parseRange returns kind text for words', () => {
  for (const s of ['Not Estab.', 'Negative', 'Non Reactive', 'None Detected', 'Not Applicable', 'See Note', 'N/A', 'NEGATIVE']) {
    const r = parseRange(s);
    assert.equal(r.kind, 'text', s); assert.equal(r.text, s);
    assert.equal(isNARangeText(s), true, s);
  }
  assert.equal(isNARangeText('3.4-10.8'), false);
  assert.deepEqual(parseRange(''), { text: null, low: null, high: null, kind: null });
  assert.deepEqual(parseRange(null), { text: null, low: null, high: null, kind: null });
});

test('normalizeRangeText canonicalizes dashes and OR= spellings', () => {
  assert.equal(normalizeRangeText('< OR = 4.0'), '<= 4.0');
  assert.equal(normalizeRangeText('0.0 – 5.0'), '0.0 - 5.0');
  assert.equal(normalizeRangeText('≥ 60'), '>= 60');
});

// ---------------------------------------------------------------- parseValue / isTextValue

test('parseValue reports a trailing abnormal star as starFlag and keeps valueText as printed', () => {
  assert.deepEqual(parseValue('6.2*'), { valueText: '6.2*', value: 6.2, qualifier: null, isText: false, starFlag: true });
  assert.deepEqual(parseValue('6.2 *'), { valueText: '6.2 *', value: 6.2, qualifier: null, isText: false, starFlag: true });
  assert.deepEqual(parseValue('6.2'), { valueText: '6.2', value: 6.2, qualifier: null, isText: false, starFlag: false });
  assert.deepEqual(parseValue('<5'), { valueText: '<5', value: 5, qualifier: '<', isText: false, starFlag: false });
  assert.deepEqual(parseValue('1,234'), { valueText: '1,234', value: 1234, qualifier: null, isText: false, starFlag: false });
  assert.deepEqual(parseValue('≤ 0.1'), { valueText: '≤ 0.1', value: 0.1, qualifier: '<=', isText: false, starFlag: false });
  assert.deepEqual(parseValue('NEGATIVE*'), { valueText: 'NEGATIVE*', value: null, qualifier: null, isText: true, starFlag: true });
  assert.equal(parseValue('abc'), null);
  assert.equal(parseValue(''), null);
  assert.equal(parseValue(null), null);
});

test('isTextValue is spacing/hyphen-insensitive, ignores a trailing "*" and knows the extra vocabulary', () => {
  for (const s of ['Non Reactive', 'NON REACTIVE', 'Non-Reactive', 'NONREACTIVE', 'None Detected', 'NONE  DETECTED', 'None Seen',
    'Not Applicable', 'Not Calc.', 'Undetectable', 'Insufficient Sample', 'NEGATIVE*', 'Not-Detected', 'Not Estab.', '1:40', '<1:80', 'See Note']) {
    assert.equal(isTextValue(s), true, s);
  }
  for (const s of ['mg/dL', '', 'Glucose', '6.2', 'Please Note']) assert.equal(isTextValue(s), false, s);
});

// ---------------------------------------------------------------- dates

test('two-digit years pivot on the current year, so 1926-1949 births are not in the future', () => {
  const now = new Date(2026, 9, 11);
  assert.equal(expandTwoDigitYear(26, now), 2026);
  assert.equal(expandTwoDigitYear(27, now), 2027);        // next year's report date is allowed
  assert.equal(expandTwoDigitYear(28, now), 1928);
  assert.equal(expandTwoDigitYear(49, now), 1949);
  assert.equal(expandTwoDigitYear(80, now), 1980);
  assert.equal(expandTwoDigitYear(0, now), 2000);
  assert.equal(parseUSDate('01/15/49').date, '1949-01-15');
  assert.equal(parseUSDate('01/15/80').date, '1980-01-15');
  assert.equal(parseUSDate('03/05/25 1023 ET').iso, '2025-03-05T10:23');
  const thisYear = new Date().getFullYear();
  assert.equal(parseUSDate(`06/01/${String(thisYear).slice(2)}`).date, `${thisYear}-06-01`);
});

// ---------------------------------------------------------------- splitLabels

test('splitLabels splits a multi-label header cell into label/value pairs (Quest "DOB: ... AGE: ... Gender: ...")', () => {
  const parts = splitLabels('DOB: 01/15/1980  AGE: 45  Gender: M', ['DOB', 'Age', 'Gender', 'Sex', 'Patient ID']);
  assert.deepEqual(parts, [
    { label: 'DOB', key: 'dob', value: '01/15/1980' },
    { label: 'AGE', key: 'age', value: '45' },
    { label: 'Gender', key: 'gender', value: 'M' },
  ]);
  assert.equal(parts.prefix, '');
});

test('splitLabels keeps text before the first label as prefix, prefers the longest label and accepts [label,key] pairs', () => {
  const parts = splitLabels('SAMPLE, ALEX Q  Date collected: 03/04/2025 0815 Local  Date: 03/05/2025',
    [['Date collected', 'collected'], ['Date', 'date'], ['Patient ID', 'patientId']]);
  assert.equal(parts.prefix, 'SAMPLE, ALEX Q');
  assert.deepEqual(parts, [
    { label: 'Date collected', key: 'collected', value: '03/04/2025 0815 Local' },
    { label: 'Date', key: 'date', value: '03/05/2025' },
  ]);
  // Map input, "#" before the colon, blank values, case-insensitivity
  const m = splitLabels('Lab Ref #: 1234567  Client #:  Specimen: AB123456C', new Map([['Lab Ref', 'labRef'], ['Client', 'client'], ['Specimen', 'specimenId']]));
  assert.deepEqual(m, [
    { label: 'Lab Ref', key: 'labRef', value: '1234567' },
    { label: 'Client', key: 'client', value: '' },
    { label: 'Specimen', key: 'specimenId', value: 'AB123456C' },
  ]);
  assert.deepEqual(splitLabels('Lipid Panel', ['DOB']), []);
  assert.deepEqual(splitLabels('', ['DOB']), []);
  assert.deepEqual(splitLabels('DOB: 01/01/2000', []), []);
  // a label must be followed by ":" and must start a word
  assert.deepEqual(splitLabels('Vitamin D, 25-OH Age 45', ['Age']), []);
  assert.deepEqual(splitLabels('Patient ID: 123  dob: 2/3/2001', ['Patient ID', 'DOB']), [
    { label: 'Patient ID', key: 'patient id', value: '123' }, { label: 'dob', key: 'dob', value: '2/3/2001' },
  ]);
});
