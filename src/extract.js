// Turn an uploaded file into plain text.
//   - PDF  -> pdf.js text layer (fast, exact) with a per-page OCR fallback
//   - image -> tesseract.js OCR
// Everything runs in the browser; nothing is uploaded anywhere.

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

let tesseractMod = null;
async function getTesseract() {
  if (!tesseractMod) tesseractMod = await import('tesseract.js');
  return tesseractMod;
}

// onProgress: (fraction 0..1, label) => void
export async function extractText(file, onProgress = () => {}) {
  const name = (file.name || '').toLowerCase();
  const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
  if (isPdf) return extractFromPdf(file, onProgress);
  return extractFromImage(file, onProgress);
}

async function extractFromPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  let ocrPagesNeeded = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress((p - 1) / pdf.numPages, `Reading page ${p} of ${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = joinTextItems(content.items);
    if (text.replace(/\s/g, '').length < 40) {
      ocrPagesNeeded.push(p); // looks like a scanned page
      pages.push({ p, text: '' });
    } else {
      pages.push({ p, text });
    }
  }

  if (ocrPagesNeeded.length) {
    const { createWorker } = await getTesseract();
    const worker = await createWorker('eng');
    for (let i = 0; i < ocrPagesNeeded.length; i++) {
      const p = ocrPagesNeeded[i];
      onProgress(i / ocrPagesNeeded.length, `Scanning page ${p} (image text)`);
      const canvas = await renderPdfPageToCanvas(pdf, p, 2);
      const { data } = await worker.recognize(canvas);
      const slot = pages.find((x) => x.p === p);
      if (slot) slot.text = data.text || '';
    }
    await worker.terminate();
  }

  onProgress(1, 'Done');
  return pages.map((x) => x.text).join('\n\n');
}

async function renderPdfPageToCanvas(pdf, pageNum, scale) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// pdf.js hands back positioned text fragments. Reassemble into lines using the
// y-coordinate, and insert line breaks where pdf.js flags end-of-line.
function joinTextItems(items) {
  let out = '';
  let lastY = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform ? it.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) out += '\n';
    out += it.str;
    if (it.hasEOL) out += '\n';
    else out += ' ';
    lastY = y;
  }
  return out;
}

async function extractFromImage(file, onProgress) {
  const { createWorker } = await getTesseract();
  const worker = await createWorker('eng', 1, {
    logger: (msg) => {
      if (msg.status === 'recognizing text') {
        onProgress(msg.progress, 'Reading image text');
      }
    },
  });
  const url = URL.createObjectURL(file);
  try {
    const { data } = await worker.recognize(url);
    onProgress(1, 'Done');
    return data.text || '';
  } finally {
    URL.revokeObjectURL(url);
    await worker.terminate();
  }
}
