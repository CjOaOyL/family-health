// Vendor detection. See docs/SPEC.md §4 and §6.

/** Evidence patterns per vendor with weights. Matching is done on each line's text. */
export const VENDOR_SIGNATURES = {
  labcorp: [
    { re: /Laboratory Corporation of America/i, w: 3, name: 'Laboratory Corporation of America' },
    { re: /\bLab[Cc]orp\b/, w: 2, name: 'Labcorp wordmark' },
    { re: /\bREFERENCE INTERVAL\b/, w: 2, name: 'REFERENCE INTERVAL column header' },
    { re: /\bTESTS?\s{2,}RESULT\s{2,}FLAG\b/, w: 2, name: 'TESTS/RESULT/FLAG table header' },
    { re: /\bTest Name\s{2,}Result\s{2,}Flag\s{2,}Units\b/, w: 2, name: 'Test Name/Result/Flag/Units table header' },
    { re: /\bDate\s+collected\s*:/i, w: 1, name: 'Date collected:' },
    { re: /\bDate\s+reported\s*:/i, w: 1, name: 'Date reported:' },
    { re: /\bSpecimen\s+(?:ID|Number|#)\s*:/i, w: 1, name: 'Specimen ID:' },
    { re: /\bOrdered\s+Items\b/i, w: 1, name: 'Ordered Items' },
    { re: /\b(?:Patient|Specimen|Physician)\s+Details\b/, w: 1, name: 'Details block header' },
    { re: /\bPatient\s+Report\b/, w: 1, name: 'Patient Report' },
    { re: /1447 York Court|Burlington,?\s+NC/i, w: 2, name: 'Burlington NC address' },
    { re: /\bDir\s*:\s*[A-Z]/, w: 0.5, name: 'Dir: legend' },
    { re: /\bx10E[36]\/uL\b/, w: 1, name: 'x10E3/uL style units' },
    { re: /800-762-4344|800-222-7566/, w: 2, name: 'Labcorp phone number' },
  ],
  quest: [
    { re: /Quest\s+Diagnostics/i, w: 3, name: 'Quest Diagnostics' },
    { re: /\bQuest\b/, w: 0.5, name: 'Quest' },
    { re: /\bIn Range\s{2,}Out of Range\b/i, w: 2, name: 'In Range/Out of Range table header' },
    { re: /\bOut of Range\b/i, w: 1, name: 'Out of Range' },
    { re: /\bPERFORMING SITE\b/, w: 2, name: 'PERFORMING SITE legend' },
    { re: /Nichols Institute|San Juan Capistrano|Teterboro/i, w: 2, name: 'Quest lab site name' },
    { re: /\bLab Ref\s*#?\s*:/i, w: 1, name: 'Lab Ref #:' },
    { re: /\bRequisition\s*:/i, w: 1, name: 'Requisition:' },
    { re: /\bClient\s+Services?\s*:/i, w: 1, name: 'Client Service(s):' },
    { re: /1\.866\.697\.8378|866-697-8378/, w: 2, name: 'Quest client service phone' },
    { re: /\b(?:Patient|Specimen|Client)\s+Information\b/, w: 1, name: 'Information block header' },
    { re: /\bMyQuest\b/i, w: 2, name: 'MyQuest' },
    { re: /\bResults for\s+[A-Z]/, w: 0.5, name: 'Results for' },
    { re: /\bYour Value\b/i, w: 1, name: 'Your Value column' },
    { re: /\bThousand\/uL\b|\bMillion\/uL\b/, w: 1, name: 'Thousand/uL style units' },
    { re: /\bCLIA\s*:\s*\d{2}D/, w: 0.5, name: 'CLIA: number' },
  ],
};

/** Minimum score for a vendor to be reported; below this → 'unknown'. */
export const MIN_SCORE = 2;
/** Score at which a vendor is considered fully confirmed (confidence 1 when unopposed). */
export const FULL_SCORE = 5;

/**
 * detectVendor(doc) → { vendor: 'labcorp'|'quest'|'unknown', confidence: 0..1, evidence: string[] }
 * Looks at every line on every page. Each signature counts once (first page it appears on).
 */
export function detectVendor(doc) {
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  const scores = { labcorp: 0, quest: 0 };
  const evidence = { labcorp: [], quest: [] };
  const hit = { labcorp: new Set(), quest: new Set() };

  for (const page of pages) {
    for (const line of page.lines || []) {
      const text = line.text || '';
      if (!text) continue;
      for (const vendor of Object.keys(VENDOR_SIGNATURES)) {
        for (const sig of VENDOR_SIGNATURES[vendor]) {
          if (hit[vendor].has(sig.name)) continue;
          if (sig.re.test(text)) {
            hit[vendor].add(sig.name);
            scores[vendor] += sig.w;
            evidence[vendor].push(`${vendor}: ${sig.name} (${line.id || 'p' + (page.pageNumber || '?')})`);
          }
        }
      }
    }
  }

  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0];
  const other = ranked[1];
  const topScore = scores[top];
  const otherScore = scores[other];
  const allEvidence = [...evidence[top], ...evidence[other]];

  if (topScore < MIN_SCORE || topScore === otherScore) {
    return { vendor: 'unknown', confidence: 0, evidence: allEvidence };
  }
  const strength = Math.min(1, topScore / FULL_SCORE);
  const margin = (topScore - otherScore) / topScore; // 1 when unopposed
  const confidence = Math.round(strength * (0.5 + 0.5 * margin) * 100) / 100;
  return { vendor: top, confidence: Math.max(0, Math.min(1, confidence)), evidence: allEvidence };
}
