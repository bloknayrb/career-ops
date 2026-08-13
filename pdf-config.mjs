/**
 * pdf-config.mjs — shared PDF page-layout config + post-generation content check.
 *
 * The CV/cover-letter PDF path (generate-pdf.mjs) imports its page margin from
 * here so the value can never drift between the renderer and its tests again:
 * two independently hardcoded margins are exactly how the page-bottom contact
 * line got clipped past the printable edge twice. This is deliberately NOT a
 * global "every PDF" margin — archive-posting.mjs renders live third-party job
 * postings at its own margin with preferCSSPageSize:false, and no invariant
 * ties that margin to the CV's. Exporting a constant it does not share would
 * be a single source of truth in name only.
 *
 * The check is a CONTENT-COVERAGE assertion, not a footer heuristic: every
 * non-whitespace character of the rendered document.body.innerText must appear,
 * in order, in the concatenated text layer of ALL PDF pages. Squashing
 * whitespace makes page boundaries invisible, so content that merely reflows
 * onto another page still passes, while content Chromium clipped past the
 * printable edge is simply absent and fails. No hardcoded markers, no
 * per-document expectation, no page-count guess.
 *
 * Grounded on the real corpus before it shipped: all 50 output/*.html rendered
 * through this assertion pass, except the one document that genuinely clips
 * (a fixed-height + overflow:hidden portfolio one-pager) — a true positive.
 * A token-multiset comparison was measured as the alternative and rejected: it
 * fails 32 of the same 50 because PDF text extraction fragments word spacing,
 * which whitespace-squashing is immune to by construction.
 *
 * KNOWN SCOPE LIMIT — RTL: the assertion cannot run on right-to-left text and
 * says so out loud instead of guessing. Chromium's text layer stores Arabic in
 * bidi VISUAL order (and as Unicode Presentation Forms); innerText is logical
 * order. NFKC below folds the presentation forms back to base letters, which
 * fixes the alphabet mismatch (measured: identical character multisets, 34/34
 * chars, zero presentation forms remaining) — but the residual difference is
 * pure reordering, which no substring test can absorb. Every rendered document
 * in the corpus today is LTR; templates/cv-template.html can produce RTL via
 * html[lang="ar"], so that path reports a visible skip rather than a false
 * failure. A silent pass is what this check exists to prevent.
 */

/**
 * The printable-page margin (all four sides) for the CV/cover-letter renderer.
 *
 * CAREER_OPS_PDF_MARGIN overrides it for tests and debugging (the coverage
 * check's own regression test renders with a deliberately absurd margin to
 * prove clipping is caught). Normal runs never set it.
 */
export const PDF_PAGE_MARGIN = process.env.CAREER_OPS_PDF_MARGIN || '0.6in';

/** Default margin used when CAREER_OPS_PDF_MARGIN is not set. */
export const PDF_PAGE_MARGIN_DEFAULT = '0.6in';

/** True when the margin came from the environment rather than the default. */
export const PDF_MARGIN_OVERRIDDEN = Boolean(process.env.CAREER_OPS_PDF_MARGIN);

/**
 * Collapse all whitespace runs to single spaces and trim.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizePdfText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Reduce text to a comparable form: whitespace-collapsed, NFKC-folded, then
 * stripped of spaces entirely.
 *
 * Removing every space is what makes page boundaries and PDF word-spacing
 * artifacts invisible to the comparison. NFKC folds glyph-level encodings that
 * a PDF text layer emits but a DOM does not — ligatures (ﬁ → fi) and Arabic
 * Presentation Forms (U+FEF4 → U+064A) — back to their base characters, so
 * both sides speak the same alphabet. It is applied to BOTH sides, so it can
 * never make absent content appear.
 *
 * @param {string} text
 * @returns {string}
 */
export function squashPdfText(text) {
  return normalizePdfText(text).normalize('NFKC').replace(/ /g, '');
}

/**
 * Capture the rendered document's full body text and its text direction.
 *
 * Runs on the live DOM after layout (and after any HTML normalization passes),
 * so it reflects exactly what went into the PDF. innerText — not textContent —
 * because it returns rendered text: it honours display:none and reflects the
 * document as laid out.
 *
 * @param {import('playwright').Page} page - Page with the document loaded.
 * @returns {Promise<{text: string, isRtl: boolean}>}
 */
export async function captureRenderedBodyText(page) {
  return page.evaluate(() => {
    const rtl = getComputedStyle(document.body).direction === 'rtl' ||
      [...document.body.querySelectorAll('*')].some((el) => getComputedStyle(el).direction === 'rtl');
    return { text: document.body.innerText || '', isRtl: rtl };
  });
}

/**
 * Extract the concatenated text layer of EVERY page of a PDF.
 *
 * All pages, not just the last: the assertion is about content surviving the
 * render, and content is free to land on any page.
 *
 * @param {string|Buffer|Uint8Array} pdf - Path to a PDF, or its bytes.
 * @returns {Promise<{text: string, numPages: number}>}
 */
export async function extractAllPdfPagesText(pdf) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let data;
  if (typeof pdf === 'string') {
    const { readFile } = await import('fs/promises');
    data = new Uint8Array(await readFile(pdf));
  } else {
    data = new Uint8Array(pdf);
  }
  const loadingTask = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  try {
    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    let text = '';
    for (let i = 1; i <= numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map((item) => item.str).join(' ') + ' ';
    }
    return { text, numPages };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Read a PDF's true page count by parsing it.
 *
 * Replaces a regex over the latin1-decoded bytes (/\/Type\s*\/Page[^s]/g),
 * which silently reported 0 on 17 of the 142 PDFs in output/ — including the
 * 33-page merged portfolio and every generated resume. Chromium emits object
 * and cross-reference STREAMS, so `/Type /Page` is compressed, not plain text
 * in the file; the regex only ever worked on PDFs that happened to use
 * uncompressed object tables. This number is printed for a human to read
 * (modes/pdf.md tells the agent to report it), so it must be true rather than
 * approximate.
 *
 * @param {string|Buffer|Uint8Array} pdf - Path to a PDF, or its bytes.
 * @returns {Promise<number>} Page count.
 */
export async function readPdfPageCount(pdf) {
  const { PDFDocument } = await import('pdf-lib');
  let bytes;
  if (typeof pdf === 'string') {
    const { readFile } = await import('fs/promises');
    bytes = await readFile(pdf);
  } else {
    bytes = pdf;
  }
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Assert that every character of the rendered document survived into the PDF.
 *
 * Returns a result instead of only throwing, because the caller must be able to
 * tell "the check passed" from "the check did not run" — printing an
 * unqualified success when nothing was verified is the failure mode this whole
 * module exists to remove.
 *
 * Throws only when the check RAN and content was missing. The skip cases (empty
 * document, RTL text, pdfjs-dist absent) return `checked: false` with a reason
 * for the caller to surface.
 *
 * @param {string} pdfPath - Path of the PDF that was just written.
 * @param {{text: string, isRtl: boolean}} body - From captureRenderedBodyText().
 * @returns {Promise<{checked: boolean, reason?: string, numPages?: number}>}
 */
export async function assertPdfContentCoverage(pdfPath, body) {
  const wanted = squashPdfText(body?.text);
  if (!wanted) {
    return { checked: false, reason: 'the rendered document has no text content to verify' };
  }
  if (body?.isRtl) {
    return {
      checked: false,
      reason: 'the document renders right-to-left text, whose PDF text layer is stored in ' +
        'bidi visual order and cannot be compared against the DOM\'s logical order',
    };
  }

  let extracted;
  try {
    extracted = await extractAllPdfPagesText(pdfPath);
  } catch (err) {
    // Narrow: only OUR import specifier being absent means "not installed".
    // Any resolution failure INSIDE pdfjs-dist is a real error and must not be
    // laundered into a reassuring skip.
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find package 'pdfjs-dist'/.test(err?.message || '')) {
      return { checked: false, reason: 'pdfjs-dist is not installed (run `npm install`)' };
    }
    throw err;
  }

  if (!squashPdfText(extracted.text).includes(wanted)) {
    throw new Error(
      `PDF content check failed: the generated PDF (${extracted.numPages} page(s)) is missing text ` +
      `that the rendered document contains. Content was likely clipped past the printable edge — ` +
      `check the page margin (currently ${PDF_PAGE_MARGIN}) against the document's own ` +
      `height/positioning, especially any fixed-height or overflow:hidden container. PDF: ${pdfPath}`
    );
  }
  return { checked: true, numPages: extracted.numPages };
}
