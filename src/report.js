/**
 * Turning verdicts into the three things a CI run is actually read through:
 * annotations on the diff, a table in the job summary, and a SARIF file for the
 * Security tab.
 *
 * All three are built from the same `results` array and none of them mutates
 * it, so a caller can produce any subset in any order. The functions that
 * produce text return text rather than writing it — writing is the caller's
 * job, and it keeps every one of these testable without a filesystem.
 */

import { toSarif } from "@attestwire/en16931";

/** Rule pages live one per rule, at a stable URL. */
export const RULES_BASE = "https://attestwire.com/rules";

/** Findings whose rule ID is ours, not the regulation's, have no rule page. */
const SYNTHETIC = /^AW-/;

export function ruleUrl(rule) {
  return SYNTHETIC.test(rule) ? null : `${RULES_BASE}/${rule}`;
}

const isFatal = (f) => f.severity === "fatal";
const isWarning = (f) => f.severity === "warning";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Business terms as one string — `field` is a term or a list of them. */
export function terms(field) {
  return Array.isArray(field) ? field.join(", ") : String(field ?? "");
}

/** Totals across every document. */
export function tally(results) {
  let errors = 0, warnings = 0, information = 0;
  for (const r of results) {
    for (const f of r.findings) {
      if (isFatal(f)) errors++;
      else if (isWarning(f)) warnings++;
      else information++;
    }
  }
  return { files: results.length, errors, warnings, information };
}

/**
 * Does this run fail the job?
 *
 * `fail-on: error` gates on fatal findings only — a warning here is something
 * the official validator raises and then accepts the document anyway, and
 * turning a build red for one by default would misrepresent the authority.
 * `fail-on: warning` is for the team that wants a clean document, and says so.
 */
export function shouldFail(counts, failOn) {
  return failOn === "warning"
    ? counts.errors > 0 || counts.warnings > 0
    : counts.errors > 0;
}

// --- where a finding is ------------------------------------------------------

/**
 * The line of the file a finding is on, or null.
 *
 * The engine's `validate` reads each finding's line and column off the file
 * it was given. For a Factur-X / ZUGFeRD PDF that is the XML attachment inside
 * it, which `location.attachment` names, and line 117 of `factur-x.xml` is not
 * line 117 of the PDF, so no line of the PDF is claimed. The engine's `toSarif`
 * draws the same line for its regions. A finding about the whole file (it
 * could not be read, or is not an invoice) has no location at all.
 */
export function lineInFile(f) {
  const at = f.location;
  return at && at.attachment === undefined ? at.line : null;
}

/**
 * Where a finding is, in the engine command line's words: the element's path
 * and line or, when the element is missing (`exact: false`), where it belongs
 * and the nearest element that is there.
 */
export function whereText(f) {
  const at = f.location;
  if (!at) return f.xpath ?? "";
  const inside = at.attachment === undefined ? "" : ` of ${at.attachment}`;
  if (at.exact) return `line ${at.line}${inside}, ${f.xpath ?? at.path}`;
  const nearest = at.path.split("/").pop().replace(/\[\d+\]$/, "");
  const near = `nearest element in the file: <${nearest}>, line ${at.line}${inside}`;
  return f.xpath ? `${f.xpath} (${near})` : `(${near})`;
}

// --- annotations -------------------------------------------------------------

/**
 * GitHub makes annotations of the first ten `::error` and the first ten
 * `::warning` lines a step prints, only logs the rest, and cuts each message
 * at 4,096 characters (`_maxCountPerIssueType` and `_maxIssueMessageLength` in
 * actions/runner).
 */
export const ANNOTATIONS_PER_STEP = 10;
const MESSAGE_LIMIT = 4096;

/** The first sentence of a message, for a one-line mention of a finding. */
function firstSentence(message) {
  const m = /^(.+?[.!?])(\s|$)/.exec(message);
  const sentence = (m ? m[1] : message).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/** "BR-CL-14 (BT-40), line 24: The country code ..." — one finding, one line. */
function mention(f) {
  const at = f.location;
  const inside = at?.attachment === undefined ? "" : ` of ${at.attachment}`;
  const line = at ? `, ${at.exact ? "line" : "near line"} ${at.line}${inside}` : "";
  return `- ${f.rule} (${terms(f.field)})${line}: ${firstSentence(f.message)}`;
}

/** As many lines as fit in `budget` characters, then how many did not. */
function within(lines, budget) {
  const out = [];
  let used = 0;
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i;
    const reserve = rest > 1 ? `- and ${rest - 1} more`.length + 1 : 0;
    if (used + line.length + 1 + reserve > budget) {
      out.push(`- and ${rest} more`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/**
 * The one annotation a file gets, or null when it has nothing above
 * informational.
 *
 * Its level is the file's worst finding, its line the line of the first
 * finding at that level (`lineInFile`), and its title that finding's rule and
 * how many more the file has. The message is that finding in full — what, the
 * fix, where — and then one line for each other finding: rule, line, and the
 * first sentence of its message. "First" is the engine's order, which puts a
 * finding that explains the others ahead of them: on a Factur-X MINIMUM file,
 * `AW-PROFILE-SUBSET` before the four rules that profile cannot satisfy.
 */
export function fileAnnotation(r, { summary = true } = {}) {
  const errors = r.findings.filter(isFatal);
  const warnings = r.findings.filter(isWarning);
  const [lead, ...others] = [...errors, ...warnings];
  if (!lead) return null;

  const counts = [
    errors.length > 0 ? plural(errors.length, "error") : "",
    warnings.length > 0 ? plural(warnings.length, "warning") : "",
  ].filter(Boolean).join(", ");
  const title = `${lead.rule} (${terms(lead.field)})` +
    (others.length > 0 ? ` and ${others.length} more: ${counts}` : "");

  const where = whereText(lead);
  let message = [lead.message, lead.fix ? `Fix: ${lead.fix}` : "", where ? `At: ${where}` : ""]
    .filter(Boolean)
    .join(" ");
  if (others.length > 0) {
    const tail = summary ? "The job summary lists every finding with its fix." : "";
    const head = `${message}\nAlso in this file:`;
    const list = within(others.map(mention), MESSAGE_LIMIT - head.length - tail.length - 2);
    message = [head, ...list, tail].filter(Boolean).join("\n");
  }

  const properties = { title, file: r.file };
  const line = lineInFile(lead);
  if (line !== null) properties.startLine = line;
  return { level: errors.length > 0 ? "error" : "warning", message, properties };
}

/**
 * One `::error` or `::warning` per file, not one per finding.
 *
 * One per finding printed a hundred lines for a few hundred invoices, of which
 * GitHub showed the first ten, and not the step's own failure message. So a
 * file gets one annotation (see `fileAnnotation`), and at most nine files get
 * an error annotation: a step with one always fails, and its failure message is
 * the tenth error. Warnings have all ten. A file past that is logged as a plain
 * line in the same words, and counted, so the step can say how many there were.
 *
 * @returns {{annotated: number, notAnnotated: number}} files annotated, and
 *   files logged instead because GitHub would not have shown them.
 */
export function emitAnnotations(results, core, { summary = true } = {}) {
  const room = { error: ANNOTATIONS_PER_STEP - 1, warning: ANNOTATIONS_PER_STEP };
  let annotated = 0, notAnnotated = 0;
  for (const r of results) {
    const a = fileAnnotation(r, { summary });
    if (!a) continue;
    if (room[a.level] > 0) {
      room[a.level]--;
      annotated++;
      (a.level === "error" ? core.error : core.warning).call(core, a.message, a.properties);
    } else {
      notAnnotated++;
      const at = a.properties.startLine === undefined ? "" : `:${a.properties.startLine}`;
      core.info(`${a.level}: ${a.properties.file}${at}: ${a.properties.title}`);
    }
  }
  return { annotated, notAnnotated };
}

// --- job summary -------------------------------------------------------------

const escapeCell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function ruleCell(rule) {
  const url = ruleUrl(rule);
  return url ? `[${rule}](${url})` : `\`${rule}\``;
}

const SEVERITY_MARK = { fatal: "error", warning: "warning", information: "note" };

/**
 * The Markdown written to `$GITHUB_STEP_SUMMARY`.
 *
 * One block per document, because a run over forty invoices read as one flat
 * table of two hundred rows tells you the count and nothing else. The per-file
 * heading carries the verdict, the syntax and the profile — the three facts
 * somebody debugging a red build asks for before they read a single rule.
 */
export function summaryMarkdown(results, { mode, engineVersion, failOn, provenance = null }) {
  const counts = tally(results);
  const verdict = counts.errors === 0 ? "PASS" : "FAIL";
  const out = [];

  out.push(`## Validate E-Invoice (EN 16931) — ${verdict}`, "");
  out.push(
    `**${counts.files}** document${counts.files === 1 ? "" : "s"} · ` +
      `**${counts.errors}** error${counts.errors === 1 ? "" : "s"} · ` +
      `**${counts.warnings}** warning${counts.warnings === 1 ? "" : "s"} · ` +
      `**${counts.information}** informational`,
    "",
  );

  const ruleset =
    mode === "api"
      ? `hosted validator (${provenance?.ruleset ?? "current rule set"}, engine ${provenance?.engine_version ?? "unknown"}) — ` +
        "[rule currency](https://attestwire.com/rule-currency)"
      : `bundled \`@attestwire/en16931@${engineVersion}\` — pinned, offline, no key`;
  out.push(`Mode: **${mode}** · Rules: ${ruleset} · Fails on: \`${failOn}\``, "");

  // Failures first, then files with only warnings; files with nothing to say
  // are one line at the end, so a failure is never buried between them.
  const rank = (r) => (r.findings.some(isFatal) ? 0 : r.findings.length > 0 ? 1 : 2);
  const ordered = results.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i);
  const clean = ordered.filter(({ r }) => r.findings.length === 0 && !r.recordUrl && !r.recordUnavailable);

  for (const { r } of ordered) {
    if (clean.some((c) => c.r === r)) continue;
    const fileErrors = r.findings.filter(isFatal).length;
    const mark = fileErrors > 0 ? "FAIL" : "pass";
    const facts = [
      r.syntax ? r.syntax.toUpperCase() : null,
      r.profile,
      r.container ? `Factur-X payload: ${r.container}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`### ${mark} — \`${r.file}\``);
    if (facts) out.push(facts, "");
    else out.push("");

    if (r.findings.length === 0) {
      out.push("No findings.", "");
    } else {
      out.push("| Severity | Rule | Term | What the regulation requires | Fix |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const f of r.findings) {
        out.push(
          `| ${SEVERITY_MARK[f.severity] ?? f.severity} | ${ruleCell(f.rule)} | ${escapeCell(terms(f.field))} ` +
            `| ${escapeCell(f.message)} | ${escapeCell(f.fix)} |`,
        );
      }
      out.push("");
    }

    if (r.recordUrl) out.push(`Validation Record: ${r.recordUrl}`, "");
    if (r.recordUnavailable) out.push(`Validation Record unavailable: ${r.recordUnavailable}`, "");
  }

  if (clean.length > 0) {
    out.push(
      `### pass — ${clean.length} document${clean.length === 1 ? "" : "s"} with no findings`,
      clean.map(({ r }) => `\`${r.file}\``).join(" · "),
      "",
    );
  }

  out.push(
    "---",
    "",
    mode === "api"
      ? "_Judged by the hosted validator against the current rule set. The verdict covers the XML document; " +
        "a Factur-X PDF container is not itself validated._"
      : "_Judged in the runner by a pinned copy of the engine — reproducible, and unaffected by rule-set changes " +
        "until you bump the action. Set `api-key` to track the current rule set instead._",
  );

  return out.join("\n");
}

// --- SARIF -------------------------------------------------------------------

/**
 * A repository-relative path as a SARIF URI reference: every segment
 * percent-encoded, the slashes kept. `Rechnung 2026-01.xml` is not a valid
 * URI, and upload-sarif decodes each URI before it reads the file, which
 * throws on a bare `%`.
 */
export function fileUri(file) {
  return file.split("/").map(encodeURIComponent).join("/");
}

/**
 * One SARIF log for the whole invocation, as ONE run over every document.
 *
 * GitHub's code scanning refuses a file holding two runs of the same tool and
 * category ("A delivery cannot contain multiple runs with the same category",
 * since July 2025) and takes at most 20 runs per file, so the run per document
 * this action wrote until 1.4.0 failed the upload for any repository with two
 * invoices. The run has:
 *
 *   - `artifacts`: every document examined, the clean ones included, so the
 *     log says what was looked at and not only what failed;
 *   - `results`: each pointing at its document by URI and artifact index, with
 *     a region (line and column) wherever the engine read one off that file;
 *   - `tool.driver.rules`: every rule that fired anywhere, once, which each
 *     result refers to by `ruleIndex`.
 *
 * The per-document work (levels, messages, logical locations, regions, rule
 * descriptors) is the engine's `toSarif`, called once per document; this only
 * merges what it returns. There is no `automationDetails`: an id in the file
 * takes precedence over upload-sarif's `category` input, and an id without a
 * slash is an empty category, so leaving it out is what lets a workflow name
 * its own category, or get one per job by default.
 */
export function buildSarif(results, { engineVersion, generatedAt, rulesetVersions } = {}) {
  const log = toSarif([], { engineVersion: engineVersion ?? "unknown", generatedAt, rulesetVersions });
  const [run] = log.runs;
  delete run.automationDetails;

  const rules = [];
  const ruleIndex = new Map();
  const artifacts = [];
  const found = [];
  results.forEach((r, index) => {
    const uri = fileUri(r.file);
    const artifact = { location: { uri }, roles: ["analysisTarget"] };
    const facts = Object.entries({ syntax: r.syntax, profile: r.profile, container: r.container })
      .filter(([, value]) => value);
    if (facts.length > 0) artifact.properties = Object.fromEntries(facts);
    artifacts.push(artifact);

    const [own] = toSarif(r.findings, { engineVersion: engineVersion ?? "unknown", documentUri: uri }).runs;
    for (const result of own.results) {
      if (!ruleIndex.has(result.ruleId)) {
        ruleIndex.set(result.ruleId, rules.length);
        rules.push(own.tool.driver.rules[result.ruleIndex]);
      }
      result.ruleIndex = ruleIndex.get(result.ruleId);
      const physical = result.locations?.[0]?.physicalLocation;
      if (physical) physical.artifactLocation = { uri, index };
      found.push(result);
    }
  });

  run.tool.driver.rules = rules;
  run.artifacts = artifacts;
  run.results = found;
  return log;
}
