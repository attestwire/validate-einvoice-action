/**
 * Reporting: the counts, the gate, the annotations, the summary, the SARIF.
 *
 * These run over hand-built findings rather than over fixtures, on purpose. The
 * question here is not "does the engine find the rule" — `read.test.js` asks
 * that — but "given findings, does the report say the right thing", and a
 * literal finding makes the expected output readable in the assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSarif, emitAnnotations, ruleUrl, shouldFail, summaryMarkdown, tally, terms,
} from "../src/report.js";
import { fakeCore } from "./helpers.js";

const fatal = {
  rule: "BR-DE-15", field: "BT-10", severity: "fatal",
  message: "XRechnung requires a buyer reference (BT-10).",
  fix: "Ask your client for their Leitweg-ID.",
  xpath: "/ubl:Invoice/cbc:BuyerReference",
  docsUrl: "https://attestwire.com/rules/BR-DE-15",
};
const warning = {
  rule: "BR-CL-01", field: ["BT-5", "BT-6"], severity: "warning",
  message: "Currency should be an ISO 4217 code.", fix: "Use EUR.",
  docsUrl: "https://attestwire.com/rules/BR-CL-01",
};
const info = {
  rule: "BR-X-01", field: "BT-1", severity: "information",
  message: "Advisory.", fix: "Nothing required.",
  docsUrl: "https://attestwire.com/rules/BR-X-01",
};
const synthetic = {
  rule: "AW-PARSE", field: "document", severity: "fatal",
  message: "bad.xml is not a document this validator can read.",
  fix: "Supply a UBL or CII invoice.",
};

const results = [
  { file: "invoices/a.xml", syntax: "ubl", profile: "xrechnung-ubl", container: null, findings: [] },
  { file: "invoices/b.xml", syntax: "ubl", profile: "xrechnung-ubl", container: null, findings: [fatal, warning, info] },
];

test("tally counts every severity separately across files", () => {
  assert.deepEqual(tally(results), { files: 2, errors: 1, warnings: 1, information: 1 });
});

test("fail-on error ignores warnings; fail-on warning does not", () => {
  const counts = { errors: 0, warnings: 3, information: 9 };
  assert.equal(shouldFail(counts, "error"), false);
  assert.equal(shouldFail(counts, "warning"), true);
  assert.equal(shouldFail({ errors: 1, warnings: 0 }, "error"), true);
});

test("informational findings never fail a build under either setting", () => {
  const counts = { errors: 0, warnings: 0, information: 40 };
  assert.equal(shouldFail(counts, "error"), false);
  assert.equal(shouldFail(counts, "warning"), false);
});

test("rule pages are linked for real rules and withheld for our own codes", () => {
  assert.equal(ruleUrl("BR-DE-15"), "https://attestwire.com/rules/BR-DE-15");
  assert.equal(ruleUrl("AW-PARSE"), null, "inventing a link that 404s is worse than having none");
});

test("terms flattens single and multiple business terms", () => {
  assert.equal(terms("BT-10"), "BT-10");
  assert.equal(terms(["BT-5", "BT-6"]), "BT-5, BT-6");
});

test("annotations carry the file, the rule, the fix and the xpath — and no line number", () => {
  const core = fakeCore();
  emitAnnotations(results, core);
  assert.equal(core.calls.errors.length, 1);
  assert.equal(core.calls.warnings.length, 1);
  const [e] = core.calls.errors;
  assert.equal(e.file, "invoices/b.xml");
  assert.equal(e.title, "BR-DE-15 (BT-10)");
  assert.match(e.message, /Fix: Ask your client/);
  assert.match(e.message, /At: \/ubl:Invoice\/cbc:BuyerReference/);
  assert.equal(e.line, undefined, "an XPath is not a line; fabricating one would be a lie");
});

test("informational findings are reported but never annotated", () => {
  const core = fakeCore();
  emitAnnotations(results, core);
  const all = [...core.calls.errors, ...core.calls.warnings].map((a) => a.title);
  assert.ok(!all.some((t) => t.startsWith("BR-X-01")));
});

test("the summary links each rule id to its page and names the mode", () => {
  const md = summaryMarkdown(results, { mode: "local", engineVersion: "0.7.0", failOn: "error" });
  assert.match(md, /\[BR-DE-15\]\(https:\/\/attestwire\.com\/rules\/BR-DE-15\)/);
  assert.match(md, /Mode: \*\*local\*\*/);
  assert.match(md, /@attestwire\/en16931@0\.7\.0/);
  assert.match(md, /pinned/);
  assert.match(md, /— FAIL/);
});

test("the summary names the hosted rule set and links rule currency in api mode", () => {
  const md = summaryMarkdown(results, {
    mode: "api", engineVersion: "0.7.0", failOn: "error",
    provenance: { engine_version: "0.7.1", ruleset: "attestwire-2026-08" },
  });
  assert.match(md, /attestwire-2026-08/);
  assert.match(md, /rule-currency/);
});

test("a clean run says PASS and lists the clean files on one line", () => {
  const md = summaryMarkdown([results[0]], { mode: "local", engineVersion: "0.7.0", failOn: "error" });
  assert.match(md, /— PASS/);
  assert.match(md, /### pass — 1 document with no findings\n`invoices\/a\.xml`/);
});

test("failures come first and clean files are not interleaved with them", () => {
  const clean = (file) => ({ file, syntax: "ubl", profile: "en16931", container: null, findings: [] });
  const failing = { file: "z-bad.xml", syntax: "ubl", profile: "en16931", container: null, findings: [fatal] };
  const md = summaryMarkdown([clean("a.xml"), failing, clean("b.xml")], {
    mode: "local", engineVersion: "0.7.0", failOn: "error",
  });
  assert.ok(md.indexOf("z-bad.xml") < md.indexOf("`a.xml`"), "the failure is listed before the clean files");
  assert.match(md, /### pass — 2 documents with no findings\n`a\.xml` · `b\.xml`/);
});

test("a CII document's annotation drops a UBL location", () => {
  const seen = [];
  const core = { error: (m) => seen.push(m), warning: (m) => seen.push(m) };
  emitAnnotations(
    [{ file: "x.xml", syntax: "cii", findings: [{ ...fatal, xpath: "/ubl:Invoice/cbc:ID" }] },
     { file: "y.xml", syntax: "ubl", findings: [{ ...fatal, xpath: "/ubl:Invoice/cbc:ID" }] }],
    core,
  );
  assert.doesNotMatch(seen[0], /At: \/ubl:/);
  assert.match(seen[1], /At: \/ubl:Invoice\/cbc:ID/);
});

test("a pipe inside a finding cannot break the summary table", () => {
  const md = summaryMarkdown(
    [{ file: "a.xml", syntax: "ubl", profile: "en16931", container: null,
       findings: [{ ...fatal, message: "a | b", fix: "c\nd" }] }],
    { mode: "local", engineVersion: "0.7.0", failOn: "error" },
  );
  const row = md.split("\n").find((l) => l.includes("BR-DE-15") && l.startsWith("| error"));
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 6, "five cells, six delimiters");
});

test("record urls appear in the summary when the API minted them", () => {
  const md = summaryMarkdown(
    [{ ...results[0], recordUrl: "https://api.attestwire.com/r/abc123" }],
    { mode: "api", engineVersion: "0.7.0", failOn: "error" },
  );
  assert.match(md, /Validation Record: https:\/\/api\.attestwire\.com\/r\/abc123/);
});

test("SARIF is one run per document, each pointing at its own file", () => {
  const log = buildSarif(results, { engineVersion: "0.7.0", generatedAt: "2026-08-15T00:00:00Z" });
  assert.equal(log.version, "2.1.0");
  assert.match(log.$schema, /sarif-schema-2\.1\.0\.json$/);
  assert.equal(log.runs.length, 2);
  assert.equal(log.runs[0].results.length, 0, "a clean file still gets a run, so its alerts resolve");
  assert.equal(log.runs[0].artifacts[0].location.uri, "invoices/a.xml");
  assert.equal(log.runs[1].results.length, 3);
});

test("SARIF levels map fatal→error, warning→warning, information→note", () => {
  const log = buildSarif([results[1]], { engineVersion: "0.7.0" });
  assert.deepEqual(log.runs[0].results.map((r) => r.level), ["error", "warning", "note"]);
});

test("SARIF results carry the rule id, the xpath as a logical location and a helpUri", () => {
  const log = buildSarif([results[1]], { engineVersion: "0.7.0" });
  const [first] = log.runs[0].results;
  assert.equal(first.ruleId, "BR-DE-15");
  assert.equal(first.locations[0].logicalLocations[0].fullyQualifiedName, "/ubl:Invoice/cbc:BuyerReference");
  assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, "invoices/b.xml");
  const driver = log.runs[0].tool.driver;
  assert.equal(driver.name, "@attestwire/en16931");
  assert.equal(driver.version, "0.7.0");
  assert.equal(driver.rules[0].helpUri, "https://attestwire.com/rules/BR-DE-15");
});

test("a finding of ours with no rule page produces valid SARIF without a helpUri", () => {
  const log = buildSarif(
    [{ file: "bad.xml", syntax: null, profile: null, container: null, findings: [synthetic] }],
    { engineVersion: "0.7.0" },
  );
  const [rule] = log.runs[0].tool.driver.rules;
  assert.equal(rule.id, "AW-PARSE");
  assert.equal(rule.helpUri, undefined);
  assert.equal(log.runs[0].results[0].level, "error");
});
