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

// --- annotations -------------------------------------------------------------

/**
 * `::error` / `::warning` per finding, attributed to the file.
 *
 * NO LINE NUMBERS, DELIBERATELY. A finding carries an XPath — a location in the
 * document's logical structure — and GitHub's annotation model wants a line.
 * Fabricating one would draw a red underline at a line chosen by arithmetic
 * rather than by evidence, which is worse than an annotation that points at the
 * file and names the XPath in its text. The same reasoning governs the SARIF
 * writer in the library itself.
 */
export function emitAnnotations(results, core) {
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === "information") continue;
      const emit = isFatal(f) ? core.error : core.warning;
      const detail = [f.message, f.fix ? `Fix: ${f.fix}` : "", f.xpath ? `At: ${f.xpath}` : ""]
        .filter(Boolean)
        .join(" ");
      emit.call(core, detail, {
        title: `${f.rule} (${terms(f.field)})`,
        file: r.file,
      });
    }
  }
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

  for (const r of results) {
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
 * One SARIF log for the whole run, one run per document.
 *
 * The library's `toSarif` produces a complete single-run log; a run over many
 * invoices needs those runs merged rather than the last one winning. Merging at
 * the `runs` level rather than concatenating results keeps each document's
 * `artifacts` and rule descriptors attached to the document they came from,
 * which is what makes GitHub attribute a finding to a file.
 *
 * Files with no findings still get a run. An empty run is how SARIF says "this
 * file was examined and was clean" — drop it and re-running with a fixed
 * invoice leaves the old alert open, because code scanning only resolves alerts
 * for artefacts the new upload mentions.
 */
export function buildSarif(results, { engineVersion, generatedAt, rulesetVersions } = {}) {
  const runs = [];
  for (const r of results) {
    const log = toSarif(r.findings, {
      engineVersion: engineVersion ?? "unknown",
      profile: r.profile ?? undefined,
      documentUri: r.file,
      generatedAt,
      rulesetVersions,
      suiteName: "validate-einvoice-action",
    });
    runs.push(...log.runs);
  }
  return {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs,
  };
}
