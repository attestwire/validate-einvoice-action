/**
 * The action, as one function over an injected `core`.
 *
 * `src/index.js` is four lines: it hands this the real `@actions/core` and
 * exits. Everything decidable — which mode, which files, what fails the build,
 * what gets written where — lives here, where a test can drive it with a fake
 * `core` and read back exactly what a runner would have been told.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as glob from "@actions/glob";
import { PROFILES, validateFile } from "./read.js";
import { validateFileViaApi } from "./api.js";
import { buildSarif, emitAnnotations, shouldFail, summaryMarkdown, tally } from "./report.js";
import { ENGINE_VERSION } from "./version.js";

const FAIL_ON = ["error", "warning"];

const bool = (value, fallback = false) => {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
};

/**
 * Read and CHECK every input before a single file is opened.
 *
 * A typo in `fail-on` that silently fell back to the default would give a green
 * build for a reason nobody could see. Every enumerated input is therefore
 * refused with the list of what it accepts, and refused up front — before the
 * work, so the failure is cheap and unambiguous.
 */
export function readInputs(core) {
  const files = core.getInput("files") || "**/*.xml";
  const profile = (core.getInput("profile") || "").trim();
  const failOn = (core.getInput("fail-on") || "error").trim().toLowerCase();
  const apiKey = (core.getInput("api-key") || "").trim();
  const record = bool(core.getInput("record"), false);
  const rawMax = (core.getInput("max-characters") || "").trim();
  const sarif = (core.getInput("sarif") || "").trim();
  const summary = bool(core.getInput("summary"), true);
  const annotations = bool(core.getInput("annotations"), true);
  const apiUrl = (core.getInput("api-url") || "https://api.attestwire.com").trim();

  if (profile && !PROFILES.includes(profile)) {
    throw new Error(
      `profile: "${profile}" is not a profile this engine knows. Use one of ${PROFILES.join(", ")}, ` +
        "or omit it to judge each document against the profile it declares.",
    );
  }
  if (!FAIL_ON.includes(failOn)) {
    throw new Error(`fail-on: "${failOn}" is not valid. Use "error" (default) or "warning".`);
  }
  let maxCharacters = null;
  if (rawMax) {
    const n = Number(rawMax);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`max-characters: "${rawMax}" is not a positive whole number of characters.`);
    }
    maxCharacters = n;
  }
  if (record && !apiKey) {
    throw new Error(
      "record: true needs api-key. A Validation Record is a third-party-checkable artefact minted by " +
        "the hosted validator; a runner cannot mint one about itself. Either supply api-key or drop record.",
    );
  }

  return {
    files, profile, failOn, apiKey, record, maxCharacters,
    sarif, summary, annotations, apiUrl,
    mode: apiKey ? "api" : "local",
  };
}

/** Expand the glob, sorted so the report is stable across runs. */
export async function discover(patterns) {
  const globber = await glob.create(patterns, { followSymbolicLinks: false });
  const found = await globber.glob();
  return found.filter((f) => /\.(xml|pdf)$/i.test(f)).sort();
}

/**
 * Absolute runner paths are noise in a report; repo-relative paths are not.
 * Always with forward slashes: annotations and SARIF URIs address files in the
 * repository, not on the runner's filesystem, and a `\`-separated path from a
 * Windows runner matches nothing on github.com.
 */
function relative(file, cwd = process.cwd()) {
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith("..")) return file;
  return rel.split(path.sep).join("/");
}

export async function run(core, { fetchImpl = fetch, cwd = process.cwd() } = {}) {
  const inputs = readInputs(core);

  const found = await discover(inputs.files);
  if (found.length === 0) {
    // An empty match is a configuration error, not a clean bill of health. A
    // pipeline that reports "valid" for zero files is the exact failure this
    // action exists to prevent, so it fails and says which pattern matched
    // nothing.
    core.setOutput("valid", "false");
    core.setOutput("error-count", "0");
    core.setOutput("warning-count", "0");
    core.setOutput("file-count", "0");
    core.setOutput("sarif-path", "");
    core.setOutput("record-urls", "");
    core.setFailed(
      `No invoice files matched \`${inputs.files.replace(/\n/g, " ")}\`. ` +
        "Nothing was validated, so this run proves nothing — fix the `files` pattern.",
    );
    return { results: [], counts: { files: 0, errors: 0, warnings: 0, information: 0 } };
  }

  core.info(
    `Validating ${found.length} document${found.length === 1 ? "" : "s"} in ${inputs.mode} mode ` +
      (inputs.mode === "local"
        ? `with @attestwire/en16931@${ENGINE_VERSION} (pinned, offline).`
        : `via ${inputs.apiUrl} (current rule set).`),
  );

  const results = [];
  for (const absolute of found) {
    const file = relative(absolute, cwd);
    const result =
      inputs.mode === "api"
        ? await validateFileViaApi(absolute, {
            apiKey: inputs.apiKey,
            apiUrl: inputs.apiUrl,
            record: inputs.record,
            maxCharacters: inputs.maxCharacters,
            profile: inputs.profile,
            fetchImpl,
          })
        : await validateFile(absolute, {
            profile: inputs.profile,
            maxCharacters: inputs.maxCharacters,
          });
    results.push({ ...result, file });
  }

  const counts = tally(results);
  const provenance = results.find((r) => r.provenance)?.provenance ?? null;

  if (inputs.annotations) emitAnnotations(results, core);

  let sarifPath = "";
  if (inputs.sarif) {
    const log = buildSarif(results, {
      engineVersion: provenance?.engine_version ?? ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
    });
    sarifPath = path.resolve(cwd, inputs.sarif);
    await mkdir(path.dirname(sarifPath), { recursive: true });
    await writeFile(sarifPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    core.info(`SARIF written to ${sarifPath}`);
  }

  if (inputs.summary) {
    const markdown = summaryMarkdown(results, {
      mode: inputs.mode,
      engineVersion: ENGINE_VERSION,
      failOn: inputs.failOn,
      provenance,
    });
    try {
      await core.summary.addRaw(markdown, true).write();
    } catch (err) {
      // No `$GITHUB_STEP_SUMMARY` means we are not on a runner, or the file is
      // unwritable. Neither is a reason to fail a validation run.
      core.debug(`Job summary not written: ${err?.message ?? err}`);
    }
  }

  const recordUrls = results.map((r) => r.recordUrl).filter(Boolean);

  core.setOutput("valid", String(counts.errors === 0));
  core.setOutput("error-count", String(counts.errors));
  core.setOutput("warning-count", String(counts.warnings));
  core.setOutput("file-count", String(counts.files));
  core.setOutput("sarif-path", sarifPath);
  core.setOutput("record-urls", recordUrls.join("\n"));

  if (shouldFail(counts, inputs.failOn)) {
    core.setFailed(
      `${counts.errors} error${counts.errors === 1 ? "" : "s"} and ${counts.warnings} ` +
        `warning${counts.warnings === 1 ? "" : "s"} across ${counts.files} document` +
        `${counts.files === 1 ? "" : "s"} (fail-on: ${inputs.failOn}).`,
    );
  } else {
    core.info(
      `All ${counts.files} document${counts.files === 1 ? "" : "s"} pass (${counts.warnings} warning` +
        `${counts.warnings === 1 ? "" : "s"}, ${counts.information} informational).`,
    );
  }

  return { results, counts, sarifPath, recordUrls, inputs };
}
