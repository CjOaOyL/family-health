// PDF → Document. pdf.js is injected (never imported here) so this module stays isomorphic.
// See docs/SPEC.md §2.
import { buildPage } from './lines.js';

/** Normalize input bytes to a Uint8Array without copying when possible. */
export function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('extract(): bytes must be a Uint8Array or ArrayBuffer');
}

/** sha256 hex via Web Crypto (available in browsers and Node >= 19 as globalThis.crypto). */
export async function sha256Hex(bytes) {
  const u8 = toUint8(bytes);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  const digest = await subtle.digest('SHA-256', u8);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * createExtractor(pdfjsLib, options?) → { extract(bytes, fileName) : Promise<Document> }
 * options.onProgress?: ({ page, pageCount }) => void
 */
export function createExtractor(pdfjsLib, options = {}) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    throw new TypeError('createExtractor(): a pdf.js library object with getDocument() is required');
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  async function extract(bytes, fileName = 'document.pdf') {
    const u8 = toUint8(bytes);
    // Hash first: pdf.js may transfer (detach) the buffer to its worker.
    const fileHash = await sha256Hex(u8);
    // Private copy for pdf.js as a *plain* Uint8Array: pdf.js may transfer the buffer, and it rejects
    // subclasses such as Node's Buffer ("Please provide binary data as Uint8Array, rather than Buffer").
    const data = new Uint8Array(u8.byteLength);
    data.set(u8);
    const params = {
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      ...(options.documentParams || {}),
    };
    if (pdfjsLib.VerbosityLevel && params.verbosity == null) params.verbosity = pdfjsLib.VerbosityLevel.ERRORS;
    const task = pdfjsLib.getDocument(params);
    const pdf = await task.promise;
    try {
      const pageCount = pdf.numPages;
      const pages = [];
      for (let n = 1; n <= pageCount; n++) {
        const page = await pdf.getPage(n);
        try {
          // rotation: 0 keeps width/height aligned with the user-space coordinates of text transforms.
          const vp = page.getViewport({ scale: 1, rotation: 0 });
          const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : [0, 0, vp.width, vp.height];
          const origin = { x: view[0], y: view[1] };
          const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
          const items = (content.items || []).filter((it) => it && typeof it.str === 'string');
          pages.push(buildPage(items, vp.width, vp.height, n, { origin }));
        } finally {
          if (typeof page.cleanup === 'function') page.cleanup();
        }
        if (onProgress) onProgress({ page: n, pageCount });
      }
      return { fileName, fileHash, pageCount, pages };
    } finally {
      try { await pdf.destroy(); } catch { /* ignore */ }
    }
  }

  return { extract };
}
