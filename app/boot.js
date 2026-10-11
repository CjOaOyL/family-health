// Bootstrap: load pdf.js (the only remote code this app ever loads) and start the app.
// PDF bytes never leave the browser; pdf.js is pinned exactly and injected into the extractor.
import { start } from './main.js';

const PDFJS_MODULE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

let pdfjsLib = null;
let pdfjsError = null;
try {
  pdfjsLib = await import(PDFJS_MODULE);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
} catch (err) {
  pdfjsError = err;
}
start({ pdfjsLib, pdfjsError });
