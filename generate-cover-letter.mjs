#!/usr/bin/env node
/**
 * generate-cover-letter.mjs — Renders a cover letter to PDF.
 *
 * Two modes:
 *
 *   PROSE MODE (preferred) — the approved .md IS the source of truth:
 *     node generate-cover-letter.mjs --markdown output/cover-letter-x.md --meta payload.json
 *
 *   PAYLOAD MODE (legacy) — prose re-keyed into template slots:
 *     node generate-cover-letter.mjs --payload payload.json
 *     node generate-cover-letter.mjs --payload payload.json --verify-prose output/cover-letter-x.md
 *
 * ## Why prose mode exists (#1699)
 *
 * modes/cover.md approves the letter as prose in chat (Step 8), then asks the
 * agent to re-type that approved prose into payload slots (Step 9: `opening`,
 * `profile_intro`, `achievements[]`, `problems_section`, `closing`). That
 * re-keying is an unverified hop: whatever the audits read is not necessarily
 * what the PDF ships.
 *
 * It has already failed in production. The Latham & Watkins letter submitted
 * 2026-07-15 contains a `profile_intro` paragraph ("I've spent 11+ years in
 * government technology consulting...") that appears nowhere in the audited
 * markdown. Both gates — the overclaim audit against Ground Truth and the voice
 * audit against the Writing Voice Guidelines — read a document that was not the
 * one sent. A gate that gets a different document than the artifact is
 * decorative.
 *
 * Prose mode removes the hop: paragraphs are lifted verbatim from the approved
 * markdown between the salutation and the sign-off, and `validateLetterProse`
 * refuses to render if any of them fail to survive into the HTML. Only
 * presentational metadata (name, contact, role title, dateline) still comes
 * from the payload/profile, because none of it is audited prose.
 *
 * `buildHtml`, `buildProseHtml`, `parseLetterMarkdown`, and
 * `validateLetterProse` are exported as pure functions so the template and the
 * fidelity guard can be tested without loading Playwright (renderHtmlToPdf is
 * imported lazily inside main).
 */

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, resolve, basename, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { parseArgs } from "util";

const OUTPUT_ROOT = resolve("output");

function safeOutputPath(raw) {
  // Derive a sanitized filename from raw string (strip path separators and dots)
  const filename = basename(raw).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
  return join(OUTPUT_ROOT, filename);
}

function _require(obj, keys, context) {
  for (const key of keys) {
    if (!obj || typeof obj !== "object" || !(key in obj)) {
      throw new Error(`Missing required field: ${context}.${key}`);
    }
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function buildContactLine(candidate) {
  const parts = [];
  if (candidate.location) parts.push(escapeHtml(candidate.location));
  if (candidate.email) {
    const email = escapeHtml(candidate.email);
    parts.push(`<a href="mailto:${email}">${email}</a>`);
  }
  if (candidate.phone) parts.push(escapeHtml(candidate.phone));
  if (candidate.linkedin) {
    parts.push(`<a href="${escapeHtml(asUrl(candidate.linkedin))}">LinkedIn</a>`);
  }
  if (candidate.github) {
    const display = candidate.github.replace(/^https?:\/\//, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.github))}">${escapeHtml(display)}</a>`);
  }
  return parts.join(" &nbsp;|&nbsp; ");
}

function buildCredentialsBlock(candidate) {
  const credentials = candidate.credentials || [];
  if (!credentials.length) return "";
  return `<div class="credentials">${credentials.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>`;
}

function buildDateline(letter) {
  const parts = [letter.company, letter.city, letter.date].filter(Boolean).map(escapeHtml);
  return parts.join(" &nbsp;&nbsp; ");
}

function buildAchievementsBlock(achievements) {
  if (!achievements || !achievements.length) return "";
  const items = achievements.map(ach => {
    const lead = escapeHtml(ach.lead || "");
    const impact = escapeHtml(ach.impact || "");
    return `    <li><b>${lead},</b> ${impact}</li>`;
  }).join("\n");
  return `<ul class="achievements">\n${items}\n  </ul>`;
}

function buildFootnotesBlock(footnotes) {
  if (!footnotes || !footnotes.length) return "";
  const lines = footnotes.map(fn => {
    if (typeof fn === "object" && fn !== null) {
      const marker = escapeHtml(fn.marker || "");
      const text = escapeHtml(fn.text || "");
      const url = fn.url
        ? ` <a href="${escapeHtml(fn.url)}">${escapeHtml(fn.url)}</a>`
        : "";
      return `    <p>${marker} ${text}${url}</p>`;
    }
    return `    <p>${escapeHtml(fn)}</p>`;
  }).join("\n");
  return `<div class="footnotes">\n${lines}\n  </div>`;
}

export function buildHtml(payload) {
  _require(payload, ["candidate", "letter"], "payload");
  const candidate = payload.candidate;
  const letter = payload.letter;
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title", "opening", "profile_intro"], "letter");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "templates", "cover-letter-template.html");
  let html = readFileSync(templatePath, "utf-8");

  // Optional salutation (e.g. "Dear Jane Smith,"). Omitted -> no salutation,
  // preserving the original behavior for payloads that don't set it.
  const greetingBlock = letter.greeting ? `<p class="greeting">${escapeHtml(letter.greeting)}</p>` : "";
  const closingBlock = letter.closing ? `<p>${escapeHtml(letter.closing)}</p>` : "";
  const languageClosingBlock = letter.language_closing
    ? `<p class="language-closing">${escapeHtml(letter.language_closing)}</p>`
    : "";
  const problemsBlock = letter.problems_section ? `<p>${escapeHtml(letter.problems_section)}</p>` : "";

  const replacements = {
    "{{NAME}}": escapeHtml(candidate.name),
    "{{CONTACT_LINE}}": buildContactLine(candidate),
    "{{CREDENTIALS_BLOCK}}": buildCredentialsBlock(candidate),
    "{{ROLE_TITLE}}": escapeHtml(letter.role_title),
    "{{DATELINE}}": buildDateline(letter),
    "{{GREETING_BLOCK}}": greetingBlock,
    "{{OPENING}}": escapeHtml(letter.opening),
    "{{PROFILE_INTRO}}": escapeHtml(letter.profile_intro),
    "{{ACHIEVEMENTS_BLOCK}}": buildAchievementsBlock(letter.achievements),
    "{{PROBLEMS_BLOCK}}": problemsBlock,
    "{{CLOSING_BLOCK}}": closingBlock,
    "{{LANGUAGE_CLOSING_BLOCK}}": languageClosingBlock,
    "{{FOOTNOTES_BLOCK}}": buildFootnotesBlock(letter.footnotes),
  };

  // Single-pass substitution: each {{TOKEN}} is replaced exactly once against
  // the original template. A single regex pass (rather than iterative
  // split/join) ensures a substituted value that itself contains a {{TOKEN}}
  // sequence is left literal instead of being re-interpreted as a placeholder.
  // Tokens with no entry in the map are left untouched.
  return html.replace(/\{\{[A-Z_]+\}\}/g, (token) => replacements[token] ?? token);
}

// ── Prose mode: the approved markdown is the source of truth ──────────

// The audited body is everything between these two lines. Anything above the
// salutation (name block, dateline, addressee) is presentation that the
// template rebuilds from metadata; anything below the sign-off is the signature.
const SALUTATION_RE = /^\s*(?:Dear|To)\b[^\n]*[,:]\s*$/;
const SIGNOFF_RE =
  /^\s*(?:Sincerely|Regards|Best regards|Kind regards|Best wishes|Yours sincerely|Yours truly|Respectfully)\s*,?\s*$/i;
const BULLET_RE = /^[-*•]\s+(.*)$/;

/**
 * Extract the audited body of a cover letter from its approved markdown.
 *
 * Deliberately strict: if the salutation or sign-off is missing we throw rather
 * than guess where the body starts, because a wrong guess silently ships a
 * truncated letter — the exact class of failure this mode exists to prevent.
 *
 * @param {string} markdown - Contents of the approved cover-letter .md file.
 * @returns {{salutation: string, blocks: Array<{type: "p", text: string}|{type: "ul", items: string[]}>,
 *   paragraphs: string[], signoff: string, signer: string}} `blocks` preserves
 *   list structure for rendering; `paragraphs` is the flat list of audited text
 *   units (one per paragraph, one per bullet) that the fidelity check verifies.
 */
export function parseLetterMarkdown(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("Cover letter markdown is empty.");
  }
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  const salIdx = lines.findIndex((line) => SALUTATION_RE.test(line));
  if (salIdx === -1) {
    throw new Error(
      'Cover letter markdown has no salutation line (expected e.g. "Dear Hiring Team,"). ' +
        "Prose mode needs it to know where the audited body starts."
    );
  }

  const signIdx = lines.findIndex((line, i) => i > salIdx && SIGNOFF_RE.test(line));
  if (signIdx === -1) {
    throw new Error(
      'Cover letter markdown has no sign-off line (expected e.g. "Sincerely,"). ' +
        "Prose mode needs it to know where the audited body ends."
    );
  }

  // Step 8 of modes/cover.md drafts achievements as a bullet list, so the body is
  // not uniformly paragraphs. Keep the list as a list: flattening it into prose
  // ships literal "- " and "**" markers into the PDF.
  const blocks = [];
  let para = [];
  let items = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (items) blocks.push({ type: "ul", items });
    items = null;
  };

  for (const raw of lines.slice(salIdx + 1, signIdx)) {
    const line = raw.trim();
    if (!line) {
      flushList();
      flushPara();
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flushPara();
      (items ??= []).push(bullet[1].trim());
    } else if (items) {
      // Unindented line under a bullet: markdown lazy continuation of that item.
      items[items.length - 1] += ` ${line}`;
    } else {
      para.push(line);
    }
  }
  flushList();
  flushPara();

  const paragraphs = blocks.flatMap((b) => (b.type === "ul" ? b.items : [b.text]));

  if (!paragraphs.length) {
    throw new Error("Cover letter markdown has no body paragraphs between the salutation and the sign-off.");
  }

  return {
    salutation: lines[salIdx].trim(),
    blocks,
    paragraphs,
    signoff: lines[signIdx].trim(),
    signer: lines.slice(signIdx + 1).map((s) => s.trim()).find(Boolean) || "",
  };
}

/**
 * Fold typography that ATS normalization would rewrite anyway, so the fidelity
 * check compares meaning rather than glyphs. Applied to BOTH sides, so it can
 * only ever cause a loud false failure, never a silent pass.
 */
function foldTypography(text) {
  return text
    .replace(/[—–]/g, "-")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/…/g, "...")
    // Emphasis markers: the source carries "**Lead,**", the render carries
    // <strong>Lead,</strong>. Dropping them on both sides compares the words.
    // Safe on the HTML side, which never contains "**" once tags are stripped.
    .replace(/\*\*/g, "")
    .replace(/[ ​‌‍⁠﻿]/g, " ");
}

/** Reduce rendered HTML to comparable plain text. */
function htmlToComparableText(html) {
  const withoutHead = html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  // &amp; must decode last, or "&amp;lt;" would wrongly become "<".
  const decoded = withoutHead
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return foldTypography(decoded).replace(/\s+/g, " ").trim();
}

/**
 * Refuse to ship a letter whose HTML has lost any audited paragraph.
 *
 * This is the whole point of prose mode: the gate and the artifact must be the
 * same document. Compares the pre-render HTML against the source paragraphs —
 * both un-normalized — so it is independent of the ATS normalization that
 * renderHtmlToPdf applies later to both alike.
 *
 * @param {string} html - HTML produced by buildProseHtml/buildHtml.
 * @param {string[]} paragraphs - Audited body paragraphs from the approved .md.
 * @throws {Error} listing every paragraph that did not survive into the HTML.
 */
export function validateLetterProse(html, paragraphs) {
  const rendered = htmlToComparableText(html);
  const missing = paragraphs
    .map((p) => foldTypography(p).replace(/\s+/g, " ").trim())
    .filter((needle) => needle && !rendered.includes(needle));

  if (missing.length) {
    const detail = missing
      .map((m) => `  - ${m.length > 110 ? `${m.slice(0, 110)}...` : m}`)
      .join("\n");
    throw new Error(
      `Cover letter PDF would not match the approved markdown. ` +
        `${missing.length} of ${paragraphs.length} audited paragraph(s) are missing from the rendered letter:\n${detail}\n` +
        `Refusing to render: the audited document and the shipped document must be the same one.`
    );
  }
}

/** Escape, then honour the only inline markdown Step 8 drafts: **bold** leads. */
function renderInline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Render the audited body, keeping bullet lists as lists. */
function renderBodyBlocks(body) {
  // Callers predating block support pass only paragraphs; treat each as prose.
  const blocks = body.blocks ?? body.paragraphs.map((text) => ({ type: "p", text }));
  return blocks
    .map((block) =>
      block.type === "ul"
        ? [
            '  <ul class="achievements">',
            ...block.items.map((item) => `    <li>${renderInline(item)}</li>`),
            "  </ul>",
          ].join("\n")
        : `  <p>${renderInline(block.text)}</p>`
    )
    .join("\n");
}

/**
 * Build cover-letter HTML from approved prose plus presentational metadata.
 *
 * @param {{candidate: object, letter: object, body: object}} input - `body` is
 *   the result of parseLetterMarkdown; `letter` supplies only metadata
 *   (role_title, company, city, date, footnotes).
 * @returns {string} Rendered HTML.
 */
export function buildProseHtml({ candidate, letter, body }) {
  _require({ candidate, letter, body }, ["candidate", "letter", "body"], "prose input");
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title"], "letter");
  _require(body, ["paragraphs"], "body");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "templates", "cover-letter-prose-template.html");
  const html = readFileSync(templatePath, "utf-8");

  const signoffBlock = body.signoff
    ? [
        '<div class="signoff">',
        `    <div class="close">${escapeHtml(body.signoff)}</div>`,
        body.signer ? `    <div class="signature">${escapeHtml(body.signer)}</div>` : "",
        "  </div>",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const replacements = {
    "{{NAME}}": escapeHtml(candidate.name),
    "{{CONTACT_LINE}}": buildContactLine(candidate),
    "{{CREDENTIALS_BLOCK}}": buildCredentialsBlock(candidate),
    "{{ROLE_TITLE}}": escapeHtml(letter.role_title),
    "{{DATELINE}}": buildDateline(letter),
    "{{GREETING_BLOCK}}": body.salutation ? `<p class="greeting">${escapeHtml(body.salutation)}</p>` : "",
    "{{BODY_BLOCK}}": renderBodyBlocks(body),
    "{{SIGNOFF_BLOCK}}": signoffBlock,
    "{{FOOTNOTES_BLOCK}}": buildFootnotesBlock(letter.footnotes),
  };

  return html.replace(/\{\{[A-Z_]+\}\}/g, (token) => replacements[token] ?? token);
}

/**
 * Mechanical voice backstop + a receipt of what was actually rendered.
 *
 * Deliberately NOT an approval gate. An attestation written by the same agent
 * that runs the screen and the renderer is circular: forging it costs one tool
 * call, which is less friction than running the screen honestly. So this refuses
 * only on Tier 1 regressions it can prove, and otherwise records the sha256 of
 * the exact text it linted. The receipt is written BY THE RENDERER, so it cannot
 * be faked by omission: if the letter changed after a voice screen, the hash in
 * the receipt is the changed one, and the drift is visible after the fact.
 *
 * Degrades to a no-op if bk-voice-lint.mjs is absent (fresh clone, other users
 * of this public fork). Never blocks on its own absence.
 */
async function runVoiceLint(source, outputPath, ack) {
  if (!source?.text) return;
  const lintPath = join(dirname(fileURLToPath(import.meta.url)), "bk-voice-lint.mjs");
  if (!existsSync(lintPath)) return;

  let lintVoice, redline;
  try {
    ({ lintVoice } = await import(pathToFileURL(lintPath).href));
    redline = await import("./redline-check.mjs").catch(() => null);
  } catch {
    return; // unloadable: a broken backstop must not block a legitimate render
  }

  const res = lintVoice(source.text, { _redline: redline });

  const receiptDir = join(OUTPUT_ROOT, ".voice-lint");
  if (!existsSync(receiptDir)) mkdirSync(receiptDir, { recursive: true });
  const receipt = join(receiptDir, `${basename(outputPath).replace(/\.pdf$/i, "")}.json`);
  writeFileSync(receipt, JSON.stringify({
    rendered_at: new Date().toISOString(),
    source: source.label,
    sha256: createHash("sha256").update(source.bytes).digest("hex"),
    stats: res.stats,
    fail: res.fail,
    warn: res.warn,
    note: "Written by the renderer, not by a reviewing agent. Records what was " +
          "linted at render time; it is NOT evidence that a voice screen ran.",
  }, null, 2));

  for (const w of res.warn) console.warn(`  voice warn: ${w}`);

  if (res.fail.length) {
    console.error(`\nERROR: voice lint found ${res.fail.length} Tier 1 violation(s):`);
    for (const f of res.fail) console.error(`  → ${f}`);
    console.error(`\nThese are rules that have already shipped broken at least once. Fix the ` +
      `letter and re-run the Step 8b audits on the corrected text.`);
    throw new Error("voice lint failed");
  }

  if (res.warn.length && !ack) {
    console.error(`\nERROR: ${res.warn.length} voice warning(s) above and no --voice-ack given.`);
    console.error(`Re-read the flagged prose. If it is genuinely correct, re-run with ` +
      `--voice-ack "why". The reason is recorded in the receipt.`);
    throw new Error("voice warnings unacknowledged");
  }
  if (ack) {
    console.log(`  voice warnings acknowledged: ${ack}`);
  }
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      payload:        { type: "string" },
      markdown:       { type: "string" },
      meta:           { type: "string" },
      "verify-prose": { type: "string" },
      "max-pages":    { type: "string" },
      format:         { type: "string" },
      out:            { type: "string" },
      // Must be declared here even though strict:false. parseArgs tolerates
      // unknown flags but does not populate `values` for them, so an undeclared
      // --voice-ack would land in positionals and read as undefined forever.
      "voice-ack":    { type: "string" },
      help:           { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (args.help || (!args.payload && !args.markdown)) {
    console.log(`
Usage:
  PROSE MODE (preferred — the approved .md is what ships):
    node generate-cover-letter.mjs --markdown output/cover-letter-x.md --meta payload.json [--out output/path.pdf]

  PAYLOAD MODE (legacy — prose re-keyed into template slots):
    node generate-cover-letter.mjs --payload payload.json [--out output/path.pdf]
    node generate-cover-letter.mjs --payload payload.json --verify-prose output/cover-letter-x.md

  --markdown       Approved cover-letter .md. Its paragraphs (between the
                   salutation and the sign-off) ship verbatim. Rendering fails
                   if any of them do not survive into the letter.
  --meta           JSON supplying candidate + letter metadata (role_title,
                   company, city, date). An existing payload file works as-is;
                   its prose slots are ignored. Defaults to --payload if given.
  --payload        Path to the JSON payload file (payload mode).
  --verify-prose   Approved .md to check the payload's prose against. Use this
                   if you must stay on payload mode: it fails the render when
                   the payload has drifted from the audited letter.
  --max-pages      Page limit; default 1. Over the limit the PDF is deleted and
                   the run fails. Raise it only when a longer letter is
                   intended, never to make an over-long draft render.
  --format         Paper size: a4 (default) or letter. Use letter for US
                   employers — A4 is narrower and 18mm taller, so a letter that
                   fits one A4 page can spill to two on US Letter.
  --out            Override output path (optional).
`);
    process.exit(args.help ? 0 : 1);
  }

  const metaPath = resolve(args.meta || args.payload || "");
  if (!args.meta && !args.payload) {
    console.error("ERROR: --markdown needs --meta (or --payload) for candidate + role metadata.");
    process.exit(1);
  }
  if (!existsSync(metaPath)) {
    console.error(`ERROR: ${args.meta ? "meta" : "payload"} file not found: ${metaPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(metaPath, "utf-8"));

  if (args.out) {
    payload.output_path = args.out;
  }

  if (!payload.output_path) {
    const company = (payload.letter?.company || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const role    = (payload.letter?.role_title || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    payload.output_path = join(OUTPUT_ROOT, `${company}-${role}-cover.pdf`);
  } else {
    payload.output_path = safeOutputPath(payload.output_path);
  }

  if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { recursive: true });

  // Imported lazily so buildHtml can be used (and tested) without Playwright.
  const { renderHtmlToPdf } = await import("./generate-pdf.mjs");

  try {
    let html;
    // The text the voice lint actually judges. Set on every path, including bare
    // --payload: linting only when --verify-prose happens to be passed would
    // leave the documented payload-only path ungated.
    let lintSource = null;

    if (args.markdown) {
      const mdPath = resolve(args.markdown);
      if (!existsSync(mdPath)) {
        console.error(`ERROR: markdown file not found: ${mdPath}`);
        process.exit(1);
      }
      const raw = readFileSync(mdPath, "utf-8");
      const body = parseLetterMarkdown(raw);
      html = buildProseHtml({ candidate: payload.candidate, letter: payload.letter, body });
      validateLetterProse(html, body.paragraphs);
      console.log(
        `Prose mode: ${body.paragraphs.length} audited paragraph(s) from ${args.markdown} verified in the rendered letter.`
      );
      lintSource = { label: args.markdown, text: body.paragraphs.join("\n\n"), bytes: raw };
    } else {
      html = buildHtml(payload);
      if (args["verify-prose"]) {
        const versusPath = resolve(args["verify-prose"]);
        if (!existsSync(versusPath)) {
          console.error(`ERROR: --verify-prose file not found: ${versusPath}`);
          process.exit(1);
        }
        const body = parseLetterMarkdown(readFileSync(versusPath, "utf-8"));
        validateLetterProse(html, body.paragraphs);
        console.log(
          `Payload verified against ${args["verify-prose"]}: all ${body.paragraphs.length} audited paragraph(s) present.`
        );
      }
      // Payload mode has no markdown to parse, so lint the rendered text itself.
      lintSource = { label: args.payload, text: htmlToComparableText(html), bytes: html };
    }

    await runVoiceLint(lintSource, payload.output_path, args["voice-ack"]);

    const format = String(args.format ?? payload.format ?? "a4").toLowerCase();
    if (!["a4", "letter"].includes(format)) {
      console.error(`ERROR: invalid --format "${format}". Use: a4, letter`);
      process.exit(1);
    }

    const outputPath = resolve(payload.output_path);
    const { pageCount } = await renderHtmlToPdf(html, outputPath, { format });

    // A cover letter that spills onto page 2 is a defect, and it is one a human
    // only catches by opening the PDF. Fail here instead: the fix is cutting the
    // letter (and re-auditing the cut), never tightening the CSS until it fits.
    const maxPages = Number(args["max-pages"] ?? 1);
    if (Number.isFinite(maxPages) && maxPages > 0 && pageCount > maxPages) {
      rmSync(outputPath, { force: true });
      console.error(
        `\nERROR: cover letter rendered ${pageCount} pages (limit ${maxPages}). Removed ${payload.output_path}.\n` +
          `Shorten the letter and re-run the audit gates on the shortened prose, or pass --max-pages ${pageCount} if a longer letter is intended.`
      );
      process.exit(1);
    }

    console.log(`\nCover letter PDF: ${payload.output_path}`);
  } catch (err) {
    console.error("ERROR generating cover letter PDF:");
    console.error(err.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
