// Canonical LabReport schema helpers. See docs/SPEC.md §3.
export const SCHEMA_VERSION = 1;

export const FLAGS = ['H', 'L', 'HH', 'LL', 'A', 'C'];

export const REQUIRED_FIELDS = [
  'patient.fullName', 'patient.dob', 'patient.sex',
  'specimen.collectedAt', 'specimen.reportedAt', 'specimen.specimenId',
  'provider.orderingName', 'source.vendor',
];

export const IMPORTANT_FIELDS = [
  'patient.patientId', 'specimen.receivedAt', 'provider.accountNumber',
  'performingLabs', 'patient.ageAtCollection', 'provider.npi',
];

export function emptyReport() {
  return {
    id: null,
    schemaVersion: SCHEMA_VERSION,
    source: { vendor: 'unknown', vendorConfidence: 0, fileName: null, fileHash: null, pageCount: 0,
      parserVersion: null, parsedAt: null, reportStatus: null },
    patient: { fullName: null, lastName: null, firstName: null, middleName: null, dob: null, sex: null,
      ageAtCollection: null, patientId: null, phone: null, address: null, memberId: null },
    specimen: { specimenId: null, requisition: null, labRef: null, collectedAt: null, collectedTz: null,
      receivedAt: null, reportedAt: null, enteredAt: null, fasting: null, collectionSite: null },
    provider: { orderingName: null, referringName: null, npi: null, accountNumber: null, accountName: null,
      address: null, phone: null, fax: null },
    performingLabs: [],
    panels: [],
    results: [],
    comments: [],
    audit: null,
  };
}

export function emptyResult(id) {
  return {
    id, panel: null, name: '', canonicalId: null, loinc: null,
    valueText: '', value: null, valueQualifier: null,
    unit: null, canonicalUnit: null, canonicalValue: null,
    flag: null,
    referenceRange: { text: null, low: null, high: null, kind: null },
    performingLabCode: null, comment: null, page: 0, lineIds: [],
    confidence: 0,
    fieldStatus: { value: 'missing', unit: 'missing', range: 'missing', flag: 'na' },
  };
}

/** Read a dotted path like 'patient.dob' from a report. */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Minimal structural validation. Returns array of problem strings (empty = valid). */
export function validateReport(r) {
  const problems = [];
  if (!r || typeof r !== 'object') return ['report is not an object'];
  for (const k of ['source', 'patient', 'specimen', 'provider']) {
    if (!r[k] || typeof r[k] !== 'object') problems.push(`missing section ${k}`);
  }
  if (!Array.isArray(r.results)) problems.push('results must be an array');
  else r.results.forEach((x, i) => {
    if (typeof x.name !== 'string' || !x.name) problems.push(`results[${i}].name missing`);
    if (x.flag != null && !FLAGS.includes(x.flag)) problems.push(`results[${i}].flag invalid: ${x.flag}`);
    if (x.value != null && typeof x.value !== 'number') problems.push(`results[${i}].value must be number|null`);
  });
  for (const p of ['patient.dob', 'specimen.collectedAt', 'specimen.reportedAt', 'specimen.receivedAt']) {
    const v = getPath(r, p);
    if (v != null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) problems.push(`${p} not ISO: ${v}`);
  }
  return problems;
}
