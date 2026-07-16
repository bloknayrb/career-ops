// tests/pdf-footer-check.test.mjs — post-generation PDF footer check (pdf-config.mjs).
//
// The page-bottom contact line has been clipped past the printable edge twice,
// by two scripts with independently hardcoded margins. pdf-config.mjs is the
// single margin source of truth and verifies, after every render, that the
// document's own bottom text made it onto the last PDF page. The marker is
// derived at runtime from the rendered document (last visible block-level
// element) — never hardcoded — so this test uses a fully synthetic fixture.
import { pass, fail, warn, NODE, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';

console.log('\ngenerate-pdf.mjs — post-generation footer check (pdf-config.mjs)');

// CI installs npm deps with --ignore-scripts and never downloads a browser
// (see .github/workflows/test.yml), so the end-to-end render can only run
// where Chromium exists — visible warn, not a failure, like other
// local-environment gaps in this suite.
const browserAvailable = (() => {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
})();

if (!browserAvailable) {
  warn('pdf footer check e2e skipped — Playwright Chromium not installed (npx playwright install chromium)');
} else {
  const fixture = join(ROOT, 'tests', 'fixtures', 'pdf-footer-fixture.html');
  const outPdf = join(ROOT, 'output', 'test-pdf-footer-fixture.pdf');
  mkdirSync(join(ROOT, 'output'), { recursive: true });

  const runPdf = (env = {}) => {
    try {
      const output = execFileSync(NODE, ['generate-pdf.mjs', fixture, outPdf, '--format=letter'], {
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

  // 1. Default margin: the fixture's CSS-positioned contact line sits inside
  //    the printable area — generation succeeds and the check reports it found.
  const ok = runPdf();
  if (ok.code === 0 && /Footer check: page-bottom text found/.test(ok.output)) {
    pass('default margin: footer inside printable area, check passes, exit 0');
  } else {
    fail(`default margin run should pass the footer check (exit ${ok.code}): ${ok.output.slice(-400)}`);
  }
  // The echoed marker proves it was derived from the fixture content at
  // runtime (including the em-dash → '-' ATS normalization), not hardcoded.
  if (/jane@example\.com/.test(ok.output)) {
    pass('footer marker is derived at runtime from the rendered fixture content');
  } else {
    fail(`footer check output should echo the runtime-derived marker text: ${ok.output.slice(-400)}`);
  }

  // 2. Absurd margin: 4in sides shrink the Letter printable area to 3in tall,
  //    the printable edge moves above the fixture's footer (top: 9.1in) and
  //    Chromium clips it out of the PDF — the run must fail loudly.
  const clipped = runPdf({ CAREER_OPS_PDF_MARGIN: '4in' });
  if (clipped.code !== 0 && /Footer check failed/.test(clipped.output)) {
    pass('4in margin override: clipped footer fails the run with a clear message and nonzero exit');
  } else {
    fail(`4in margin run should fail the footer check (exit ${clipped.code}): ${clipped.output.slice(-400)}`);
  }

  rmSync(outPdf, { force: true });
}
