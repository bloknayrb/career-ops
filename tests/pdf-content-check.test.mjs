// tests/pdf-content-check.test.mjs — post-generation PDF content-coverage check.
//
// The page-bottom contact line has been clipped past the printable edge twice,
// by two scripts with independently hardcoded margins. pdf-config.mjs is the
// margin source of truth for the CV/cover path and verifies, after every
// render, that EVERY character of the rendered document survived into the PDF.
//
// Two fixtures, because the repo ships two real document regimes and a check
// that cannot tell them apart is worthless:
//   * pdf-footer-fixture.html — fixed height + overflow:hidden + a bottom-pinned
//     footer (the shape of output/rain-portfolio-*.html). Content that does not
//     fit is CLIPPED, and must FAIL.
//   * pdf-flow-fixture.html — ordinary flowing content. Content that does not
//     fit REFLOWS onto another page, and must PASS at 1, 2 and 3 pages.
// Page count alone provably cannot separate these: a pinned document renders
// the expected page count with its footer gone.
//
// Both fixtures are fully synthetic — no real person's data.
import { pass, fail, warn, NODE, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';
import { readPdfPageCount } from '../pdf-config.mjs';

console.log('\ngenerate-pdf.mjs — post-generation content-coverage check (pdf-config.mjs)');

const browserAvailable = (() => {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
})();

if (!browserAvailable) {
  // CI installs Chromium for this job precisely so this check runs there
  // (.github/workflows/test.yml). A silent skip in CI is how a guard rots into
  // decoration — the same class of failure this check exists to prevent — so
  // in CI a missing browser is a hard failure, not a warning.
  if (process.env.CI === 'true') {
    fail('pdf content check cannot run: Playwright Chromium is missing in CI (test.yml must install it)');
  } else {
    warn('pdf content check e2e skipped — Playwright Chromium not installed (npx playwright install chromium)');
  }
} else {
  const pinnedFixture = join(ROOT, 'tests', 'fixtures', 'pdf-footer-fixture.html');
  const flowFixture = join(ROOT, 'tests', 'fixtures', 'pdf-flow-fixture.html');
  const outPdf = join(ROOT, 'output', 'test-pdf-content-fixture.pdf');
  const tmpHtml = join(ROOT, 'tests', 'fixtures', '.pdf-flow-variant.html');
  mkdirSync(join(ROOT, 'output'), { recursive: true });

  const runPdf = (input, env = {}) => {
    try {
      const output = execFileSync(NODE, ['generate-pdf.mjs', input, outPdf, '--format=letter'], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 120000,
        env: { ...process.env, ...env },
        // Pipe stderr: the deliberate-fail run prints its ❌ there, which
        // would otherwise leak into the suite output and read like a failure.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, output };
    } catch (e) {
      return { code: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  // Build a flow variant with exactly n content blocks, cycling the fixture's
  // own blocks. Counts are calibrated against the 0.6in Letter printable area.
  const buildFlowVariant = (n) => {
    const html = readFileSync(flowFixture, 'utf-8');
    const blocks = [...html.matchAll(/<section class="block">[\s\S]*?<\/section>\s*/g)].map((m) => m[0]);
    const body = Array.from({ length: n }, (_, i) => blocks[i % blocks.length]).join('');
    const start = html.indexOf(blocks[0]);
    const last = blocks[blocks.length - 1];
    const end = html.lastIndexOf(last) + last.length;
    writeFileSync(tmpHtml, html.slice(0, start) + body + html.slice(end), 'utf-8');
    return tmpHtml;
  };

  // 1. Pinned fixture, default margin: the CSS-positioned contact line sits
  //    inside the printable area — generation succeeds and the check runs.
  const ok = runPdf(pinnedFixture);
  if (ok.code === 0 && /Content check: all rendered text present/.test(ok.output)) {
    pass('pinned fixture, default margin: all content present, check runs, exit 0');
  } else {
    fail(`pinned fixture at default margin should pass the content check (exit ${ok.code}): ${ok.output.slice(-400)}`);
  }

  // 2. Pinned fixture, absurd margin: 4in sides shrink the Letter printable
  //    area to 3in tall; the printable edge moves above the footer (top: 9.1in)
  //    and Chromium clips it out. overflow:hidden means it cannot reflow to a
  //    second page instead — so this is a true clip and must fail the run.
  writeFileSync(outPdf, 'SENTINEL-GOOD-PDF', 'utf-8');
  const clipped = runPdf(pinnedFixture, { CAREER_OPS_PDF_MARGIN: '4in' });
  if (clipped.code !== 0 && /PDF content check failed/.test(clipped.output)) {
    pass('pinned fixture, 4in margin: clipped content fails the run with a clear message and nonzero exit');
  } else {
    fail(`pinned fixture at 4in margin should fail the content check (exit ${clipped.code}): ${clipped.output.slice(-400)}`);
  }

  // 3. A failed check must not overwrite the previous good artifact: the PDF is
  //    rendered to a temp path and promoted only after the check passes.
  //    Otherwise a bad PDF lands at outputPath while data/pdf-index.tsv still
  //    points at it as if it were good.
  if (readFileSync(outPdf, 'utf-8') === 'SENTINEL-GOOD-PDF') {
    pass('failed content check leaves the previous PDF at outputPath untouched (temp-then-promote)');
  } else {
    fail('failed content check overwrote the existing PDF at outputPath');
  }
  rmSync(outPdf, { force: true });

  // 4. Flow fixture at 1, 2 and 3 pages: content that reflows across page
  //    boundaries must still pass. Whitespace-squashing makes the page break
  //    invisible to the comparison — this is what stops the check from being a
  //    disguised one-page rule.
  for (const [blocks, expectedPages] of [[4, 1], [20, 2], [36, 3]]) {
    const variant = buildFlowVariant(blocks);
    const res = runPdf(variant);
    const okRun = res.code === 0 && /Content check: all rendered text present/.test(res.output);
    let actualPages = null;
    try { actualPages = await readPdfPageCount(outPdf); } catch {}
    if (okRun && actualPages === expectedPages) {
      pass(`flow fixture at ${expectedPages} page(s): reflowed content passes the content check`);
    } else {
      fail(`flow fixture should pass at ${expectedPages} page(s) (exit ${res.code}, pages ${actualPages}): ${res.output.slice(-300)}`);
    }
    // The printed page count must be the PDF's real page count, not a regex
    // guess over latin1 bytes (which reported 0 on 17 of 142 real PDFs).
    const printed = /Pages: (\d+)/.exec(res.output)?.[1];
    if (printed !== undefined && Number(printed) === actualPages) {
      pass(`printed page count matches the parsed PDF page count (${actualPages})`);
    } else {
      fail(`printed page count ${printed} does not match parsed count ${actualPages}`);
    }
    rmSync(outPdf, { force: true });
  }

  // 5. RTL is the check's known scope limit (a PDF text layer stores Arabic in
  //    bidi visual order; innerText is logical order). It must say so out loud:
  //    a visible skip with a reason, never a false failure, and never an
  //    unqualified success tick for a check that did not run.
  const rtl = runPdf(join(ROOT, 'tests', 'fixtures', 'pdf-rtl-fixture.html'));
  const skipped = /Content check skipped — .*right-to-left/.test(rtl.output);
  const noFalseGreen = !/✅ PDF generated/.test(rtl.output);
  if (rtl.code === 0 && skipped && noFalseGreen) {
    pass('RTL document: content check reports a visible skip with a reason, not a false pass or fail');
  } else {
    fail(`RTL document should skip loudly and not print an unqualified success (exit ${rtl.code}): ${rtl.output.slice(-400)}`);
  }
  rmSync(outPdf, { force: true });

  // 6. The margin override must be echoed on the success path, so a run made
  //    with a non-default margin can never be mistaken for a normal one.
  const echoed = runPdf(buildFlowVariant(4), { CAREER_OPS_PDF_MARGIN: '0.75in' });
  if (echoed.code === 0 && /Margin: 0\.75in \(overridden/.test(echoed.output)) {
    pass('overridden margin is echoed on the success path');
  } else {
    fail(`overridden margin should be echoed on success (exit ${echoed.code}): ${echoed.output.slice(-300)}`);
  }
  rmSync(outPdf, { force: true });
  rmSync(tmpHtml, { force: true });
}
