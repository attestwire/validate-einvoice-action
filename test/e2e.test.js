/**
 * The built bundle, run the way a runner runs it.
 *
 * Everything else in this suite imports `src/`. GitHub does not: it executes
 * `dist/index.js` with `node20`, feeds inputs through `INPUT_*` environment
 * variables and reads outputs out of a file. A bundler misconfiguration — a
 * dependency left external, an ESM/CJS mismatch, a dynamic import ncc could not
 * see — is invisible to every other test in this directory and total in
 * production, so it gets its own.
 *
 * The exit code is the assertion that matters most. It is the entire contract
 * between this action and the workflow that runs it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FIXTURES, HERE } from "./helpers.js";
import { ENGINE_VERSION } from "../src/version.js";

const run = promisify(execFile);
const BUNDLE = path.join(HERE, "..", "dist", "index.js");

/** Run the bundle, resolving with the exit code instead of throwing on failure. */
async function runAction(inputs, extraEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "einvoice-e2e-"));
  const outputFile = path.join(dir, "outputs");
  const summaryFile = path.join(dir, "summary.md");
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");

  const env = {
    PATH: process.env.PATH,
    // Windows cannot run a process without its OS root; absent elsewhere.
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    ...Object.fromEntries(
      Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, String(v)]),
    ),
    ...extraEnv,
  };

  let code = 0, stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await run(process.execPath, [BUNDLE], { env }));
  } catch (err) {
    code = err.code ?? 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }

  // `key=value` and the heredoc form both appear in $GITHUB_OUTPUT; the values
  // this action writes are single-line, so the simple form is what we parse.
  // `@actions/core` writes with os.EOL, so a Windows run needs the `\r`s gone
  // before a value can be compared with `===`.
  const raw = (await readFile(outputFile, "utf8")).replace(/\r\n/g, "\n");
  const outputs = Object.fromEntries(
    [...raw.matchAll(/^(.+?)<<ghadelimiter_[^\n]+\n([\s\S]*?)\nghadelimiter_[^\n]+$/gm)]
      .map(([, k, v]) => [k, v]),
  );

  return { code, stdout, stderr, outputs, dir, summary: await readFile(summaryFile, "utf8") };
}

test("the bundle passes a conformant invoice with exit code 0", async () => {
  const r = await runAction({ files: path.join(FIXTURES, "xrechnung-ubl-minimal.xml") });
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(r.outputs.valid, "true");
  assert.equal(r.outputs["error-count"], "0");
  assert.equal(r.outputs["file-count"], "1");
});

test("the bundle fails a non-conformant invoice with exit code 1 and a ::error line", async () => {
  const r = await runAction({ files: path.join(FIXTURES, "xrechnung-ubl-missing-buyer-reference.xml") });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.valid, "false");
  assert.equal(r.outputs["error-count"], "1");
  assert.match(r.stdout, /::error /);
  assert.match(r.stdout, /BR-DE-15/);
  assert.match(r.stdout, /::error::1 error/, "the step failure names the count");
});

test("the bundle writes a SARIF log a code-scanning upload would accept", async () => {
  const sarif = path.join(await mkdtemp(path.join(tmpdir(), "einvoice-sarif-")), "einvoice.sarif");
  const r = await runAction({
    files: path.join(FIXTURES, "xrechnung-ubl-missing-buyer-reference.xml"),
    sarif,
  });
  assert.equal(r.code, 1);
  assert.equal(r.outputs["sarif-path"], sarif);

  const log = JSON.parse(await readFile(sarif, "utf8"));
  assert.equal(log.version, "2.1.0");
  assert.match(log.$schema, /sarif-schema-2\.1\.0\.json$/);
  assert.equal(log.runs.length, 1);

  const [runLog] = log.runs;
  assert.equal(runLog.tool.driver.name, "@attestwire/en16931");
  assert.equal(runLog.tool.driver.version, ENGINE_VERSION);
  assert.ok(Array.isArray(runLog.tool.driver.rules));
  assert.equal(runLog.tool.driver.rules[0].id, "BR-DE-15");
  assert.equal(runLog.tool.driver.rules[0].helpUri, "https://attestwire.com/rules/BR-DE-15");

  assert.equal(runLog.results.length, 1);
  const [finding] = runLog.results;
  assert.equal(finding.ruleId, "BR-DE-15");
  assert.equal(finding.ruleIndex, 0);
  assert.equal(finding.level, "error");
  assert.ok(finding.message.text.length > 0);
  assert.match(finding.locations[0].physicalLocation.artifactLocation.uri, /\.xml$/);
  assert.equal(runLog.invocations[0].executionSuccessful, true);
});

test("the bundle writes the job summary with linked rule ids", async () => {
  const r = await runAction({ files: path.join(FIXTURES, "xrechnung-ubl-missing-buyer-reference.xml") });
  assert.match(r.summary, /## Validate E-Invoice \(EN 16931\) — FAIL/);
  assert.match(r.summary, /\[BR-DE-15\]\(https:\/\/attestwire\.com\/rules\/BR-DE-15\)/);
  assert.match(r.summary, /Mode: \*\*local\*\*/);
});

test("the bundle fails, rather than passing quietly, when nothing matched", async () => {
  const r = await runAction({ files: path.join(FIXTURES, "no-such-*.xml") });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /proves nothing/);
});

test("the bundle refuses a mistyped input before doing any work", async () => {
  const r = await runAction({
    files: path.join(FIXTURES, "*.xml"), "fail-on": "never",
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /fail-on/);
});

test("the bundle needs no network and no key in local mode", async () => {
  // Node resolves nothing over the network here; the point of the assertion is
  // that the run completes with neither an API key nor any HTTP proxy set, on a
  // fixture set that includes a PDF container.
  const r = await runAction(
    { files: path.join(FIXTURES, "facturx-en16931-einfach.pdf") },
    { HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" },
  );
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(r.outputs.valid, "true");
});
