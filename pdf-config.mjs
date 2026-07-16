/**
 * pdf-config.mjs — shared PDF page-layout config + post-generation footer check.
 *
 * Every PDF code path imports its page margin from here so the value can never
 * drift between scripts again: two independently hardcoded margins are exactly
 * how the page-bottom contact line got clipped past the printable edge twice,
 * in two different scripts.
 *
 * The footer check is content-derived at runtime. After Chromium lays the page
 * out, `deriveFooterMarker()` reads the rendered text of the LAST visible
 * block-level element in the document — whatever content the document itself
 * puts at the bottom. After the PDF is written, `assertPdfFooter()` extracts
 * the LAST page's text layer (pdfjs-dist legacy build — pure JS, no canvas
 * binding; its "fake worker" warning on Node is harmless) and requires the
 * marker to be present. No hardcoded marker strings, so the check works for
 * any input document and never needs to know whose CV it is rendering.
 */

/**
 * Single source of truth for the printable-page margin (all four sides).
 *
 * CAREER_OPS_PDF_MARGIN overrides it for tests and debugging (e.g. the footer
 * check's own regression test renders with a deliberately absurd margin to
 * prove clipping is caught). Normal runs never set it.
 */
export const PDF_PAGE_MARGIN = process.env.CAREER_OPS_PDF_MARGIN || '0.6in';

/**
 * Normalize text for marker comparison: collapse all whitespace runs and trim.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizePdfText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Derive the footer marker from a live Playwright page: the rendered text of
 * the last visible block-level element in document order. Children follow
 * their parents in document order, so the last qualifying element is also the
 * deepest one — the concrete line of text at the bottom of the document, not
 * a wrapper that happens to contain the whole page.
 *
 * Runs on the rendered DOM (after any HTML normalization passes), so the
 * marker always matches what actually went into the PDF.
 *
 * @param {import('playwright').Page} page - Page with the document loaded.
 * @param {{maxChars?: number}} [opts] - Cap on marker length; long tail-end
 *   elements keep only their final characters (clipping cuts from the end,
 *   so the tail is the part worth checking).
 * @returns {Promise<string>} Normalized marker text, or '' if the document
 *   has no text-bearing block element.
 */
export async function deriveFooterMarker(page, { maxChars = 200 } = {}) {
  const raw = await page.evaluate(() => {
    let last = null;
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.display === 'contents' || cs.display.startsWith('inline')) continue;
      if (cs.visibility === 'hidden') continue;
      if (el.getClientRects().length === 0 && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) continue;
      last = el;
    }
    return last ? (last.innerText || last.textContent || '') : '';
  });
  const normalized = normalizePdfText(raw);
  return normalized.length > maxChars ? normalized.slice(-maxChars) : normalized;
}

/**
 * Extract the text layer of the LAST page of a PDF file.
 *
 * @param {string} pdfPath - Path to the PDF on disk.
 * @returns {Promise<{text: string, numPages: number}>}
 */
export async function extractLastPdfPageText(pdfPath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { readFile } = await import('fs/promises');
  const data = new Uint8Array(await readFile(pdfPath));
  const loadingTask = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  try {
    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    const lastPage = await doc.getPage(numPages);
    const content = await lastPage.getTextContent();
    const text = content.items.map((item) => item.str).join(' ');
    return { text, numPages };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Assert that the runtime-derived footer marker survived into the generated
 * PDF's last page. Throws with an actionable message when it did not — a
 * clipped contact line must fail the run, never ship silently.
 *
 * Comparison is whitespace-insensitive (all spaces stripped on both sides):
 * PDF text extraction does not always reproduce the DOM's exact word spacing.
 *
 * Degrades to a visible warning — never a hard failure — in the two cases
 * where there is nothing meaningful to check: the document has no
 * text-bearing block element, or pdfjs-dist is not installed (stale
 * node_modules from before it became a dependency).
 *
 * @param {string} pdfPath - Path of the PDF that was just written.
 * @param {string} marker - Marker from deriveFooterMarker().
 * @returns {Promise<void>}
 */
export async function assertPdfFooter(pdfPath, marker) {
  const wanted = normalizePdfText(marker);
  if (!wanted) {
    console.warn('⚠️  Footer check skipped: no text-bearing block element found in the source document');
    return;
  }

  let extracted;
  try {
    extracted = await extractLastPdfPageText(pdfPath);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('⚠️  Footer check skipped: pdfjs-dist is not installed (run `npm install`)');
      return;
    }
    throw err;
  }

  const squash = (s) => normalizePdfText(s).replace(/ /g, '');
  const snippet = wanted.length > 120 ? `…${wanted.slice(-120)}` : wanted;
  if (!squash(extracted.text).includes(squash(wanted))) {
    throw new Error(
      `Footer check failed: the last PDF page (page ${extracted.numPages}) does not contain the ` +
      `page-bottom text of the source document ("${snippet}"). The bottom-of-page content was ` +
      `likely clipped past the printable edge — check the page margin (currently ${PDF_PAGE_MARGIN}) ` +
      `against the document's own height/positioning. PDF: ${pdfPath}`
    );
  }
  console.log(`🧾 Footer check: page-bottom text found on last PDF page ("${snippet}")`);
}
