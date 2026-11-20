// tests/pdf-coverage-generated-content.test.mjs — FORK-LOCAL: the PDF content
// check compares against what the browser prints, including CSS generated
// content.
//
// Since v1.40.0 templates/cv-template.html draws the contact-row separators as
// `.contact-row > *:not(:last-child)::after { content: "|" }`. Chromium paints
// those "|" into the PDF text layer, but innerText leaves them out, so the
// contiguous coverage match broke at the first separator and EVERY CV render
// failed as "clipped". The fix materialises generated content in the captured
// text; these tests pin that, and pin that real clipping still fails.
//
// Run:  node --test tests/pdf-coverage-generated-content.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toolRequired } from './required-tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { captureRenderedBodyText, assertPdfContentCoverage, PDF_PAGE_MARGIN } =
  await import(pathToFileURL(join(ROOT, 'pdf-config.mjs')).href);

let chromium;
let launchError = null;
try {
  ({ chromium } = await import('playwright'));
  const probe = await chromium.launch({ headless: true });
  await probe.close();
} catch (err) {
  launchError = err;
}
// A missing Chromium skips locally but fails where the run requires a browser
// (the tool-suites CI job sets the env var tests/required-tools.mjs names).
const skip = launchError && !toolRequired('browser')
  ? `Chromium cannot launch (${String(launchError.message).split('\n')[0]})`
  : false;
if (launchError && !skip) {
  test('Chromium launches (required in this run)', () => { throw launchError; });
}

// Same rule shape the CV template ships, on synthetic contact data.
const CONTACT_CSS = `
  .contact-row { display: flex; flex-wrap: wrap; column-gap: 14px; }
  .contact-row > *:not(:last-child)::after { content: "|"; color: #ccc; margin-inline-start: 14px; }
  .lead::before { content: "Note: "; }
  .hidden-pseudo::after { content: "NEVER-PRINTED"; display: none; }
  .hex::after { content: "\\A tail"; }
  .wrap .contact-row::after { content: "END"; }
  .typed > span { display: none; }
  .typed::before { content: "PRE"; }
  .faded::after { content: "OPACITY-ZERO"; opacity: 0; }
  .tiny::after { content: "FONT-ZERO"; font-size: 0; }
`;
const CONTACT_ROW = `
  <div class="contact-row">
    <span>+1 555 0100</span>
    <a href="mailto:candidate@example.invalid">candidate@example.invalid</a>
    <span>Springfield</span>
  </div>`;

// Page size and margin through CSS @page, as generate-pdf.mjs's
// injectPrintPageCss() does, printed with the same page.pdf() options.
const doc = (body) => `<!doctype html><html lang="en"><head><style>
  @page { size: Letter; margin: ${PDF_PAGE_MARGIN}; }${CONTACT_CSS}</style></head><body>${body}</body></html>`;

// The same capture -> print -> assert sequence generate-pdf.mjs runs. Not
// through renderHtmlToPdf itself: that also records the PDF in the real data
// root's data/pdf-index.tsv, which a test must never touch.
async function render(html) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'career-ops-pdf-gencontent-')));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const body = await captureRenderedBodyText(page);
    const pdfPath = join(workspace, 'cv.pdf');
    writeFileSync(pdfPath, await page.pdf({
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: true,
    }));
    return await assertPdfContentCoverage(pdfPath, body);
  } finally {
    await browser.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('a CV whose contact separators are ::after content passes the content check', { skip }, async () => {
  const html = doc(`<h1>Test Candidate</h1>${CONTACT_ROW}
    <p class="lead">builds test systems.</p><p class="hidden-pseudo">Fictional Ltd</p>`);
  const result = await render(html);
  assert.equal(result.checked, true, 'the check ran rather than skipping');
});

test('the capture includes printed generated content and restores the DOM', { skip }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The row's own ::after makes this a test of read-then-insert: inserting while
    // reading would make "Springfield" stop being :last-child and gain a "|".
    await page.setContent(doc(`<div class="wrap">${CONTACT_ROW}</div>`
      + '<p class="lead">x</p><p class="hidden-pseudo">y</p><p class="hex">head</p>'
      + '<p class="faded">a</p><p class="tiny">b</p>'
      + '<p class="typed"><span>HIDDEN-SPAN</span><b>shown</b></p>'));
    const before = await page.evaluate(() => document.body.innerHTML);
    const { text } = await captureRenderedBodyText(page);
    const squashed = text.replace(/\s+/g, '');
    assert.match(squashed, /\+15550100\|candidate@example\.invalid\|SpringfieldEND/);
    assert.match(squashed, /headtail/, 'a hex escape (\\A) decodes to a line break, not a literal "a"');
    assert.match(squashed, /Note:x/);
    assert.doesNotMatch(text, /NEVER-PRINTED/, 'a display:none pseudo-element is not printed');
    assert.doesNotMatch(text, /OPACITY-ZERO/, 'an opacity:0 pseudo-element prints nothing');
    assert.doesNotMatch(text, /FONT-ZERO/, 'a font-size:0 pseudo-element prints nothing');
    assert.match(squashed, /PREshown/, 'an author `span` type selector does not hide the captured text');
    assert.doesNotMatch(text, /HIDDEN-SPAN/, 'the hidden author span stays out');
    assert.equal(await page.evaluate(() => document.body.innerHTML), before, 'temporary nodes were removed');
  } finally {
    await browser.close();
  }
});

test('genuinely clipped content still fails the content check', { skip }, async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `<p>Clipped line ${i} of fictional experience.</p>`).join('');
  const html = doc(`<h1>Test Candidate</h1>${CONTACT_ROW}
    <div style="height: 1in; overflow: hidden">${filler}</div>`);
  await assert.rejects(render(html), /PDF content check failed/);
});
