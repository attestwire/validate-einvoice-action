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
import { toSarif } from "@attestwire/en16931";
import {
  ANNOTATIONS_PER_STEP, buildSarif, emitAnnotations, fileAnnotation, fileUri, lineInFile, ruleUrl,
  shouldFail, summaryMarkdown, tally, terms, whereText,
} from "../src/report.js";
import { fakeCore } from "./helpers.js";
import { schemaErrors, uploadErrors } from "./sarif-check.js";

// A missing element: located at the nearest element that is there.
const fatal = {
  rule: "BR-DE-15", field: "BT-10", severity: "fatal",
  message: "XRechnung requires a buyer reference (BT-10).",
  fix: "Ask your client for their Leitweg-ID.",
  xpath: "/ubl:Invoice/cbc:BuyerReference",
  docsUrl: "https://attestwire.com/rules/BR-DE-15",
  location: { line: 2, column: 1, path: "/ubl:Invoice", exact: false },
};
// An element that is there, and wrong.
const country = {
  rule: "BR-CL-14", field: "BT-40", severity: "fatal",
  message: "The seller country code must be an ISO 3166-1 code. XX is not one.",
  fix: "Use DE.",
  xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
  docsUrl: "https://attestwire.com/rules/BR-CL-14",
  location: {
    line: 24, column: 11, exact: true,
    path: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
  },
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
  message: "This is not an invoice this validator can read.",
  fix: "Supply a UBL or CII invoice.",
};
// From a Factur-X PDF: the line is in the attachment, not in the PDF.
const inPdf = {
  rule: "BR-16", field: "BG-25", severity: "fatal",
  message: "An invoice must have at least one invoice line (BG-25). A document with no lines is not an invoice.",
  fix: "Add a line.",
  xpath: "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:IncludedSupplyChainTradeLineItem",
  docsUrl: "https://attestwire.com/rules/BR-16",
  location: {
    line: 103, column: 3, exact: false, attachment: "factur-x.xml",
    path: "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction",
  },
};
const subset = {
  rule: "AW-PROFILE-SUBSET", field: "BT-24", severity: "fatal",
  message: "This is a Factur-X MINIMUM document. MINIMUM carries too little to be an EN 16931 invoice.",
  fix: "Export at the EN 16931 (COMFORT) or EXTENDED profile instead.",
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

// --- locations ---------------------------------------------------------------

test("a finding's line is used only when it is a line of the file itself", () => {
  assert.equal(lineInFile(fatal), 2);
  assert.equal(lineInFile(country), 24);
  assert.equal(lineInFile(inPdf), null, "line 103 of factur-x.xml is not line 103 of the PDF");
  assert.equal(lineInFile(synthetic), null, "a finding about the whole file has no line");
});

test("where a finding is reads like the engine's command line", () => {
  assert.equal(whereText(country), `line 24, ${country.xpath}`);
  assert.equal(whereText(fatal),
    "/ubl:Invoice/cbc:BuyerReference (nearest element in the file: <ubl:Invoice>, line 2)");
  assert.equal(whereText(inPdf),
    `${inPdf.xpath} (nearest element in the file: <rsm:SupplyChainTradeTransaction>, line 103 of factur-x.xml)`);
  assert.equal(whereText(warning), "", "no location and no path: nothing to say");
});

// --- annotations -------------------------------------------------------------

test("a file with one finding gets one annotation, on its line, carrying the fix and where", () => {
  const core = fakeCore();
  emitAnnotations([{ file: "invoices/b.xml", syntax: "ubl", findings: [fatal] }], core);
  assert.equal(core.calls.errors.length, 1);
  const [e] = core.calls.errors;
  assert.equal(e.file, "invoices/b.xml");
  assert.equal(e.title, "BR-DE-15 (BT-10)");
  assert.equal(e.startLine, 2, "the line the engine read off the file");
  assert.match(e.message, /Fix: Ask your client/);
  assert.match(e.message, /At: \/ubl:Invoice\/cbc:BuyerReference \(nearest element in the file: <ubl:Invoice>, line 2\)/);
});

test("a file with several findings gets ONE annotation, with the count and the others listed", () => {
  const core = fakeCore();
  emitAnnotations([{ file: "b.xml", syntax: "ubl", findings: [fatal, country, warning, info] }], core);
  assert.equal(core.calls.errors.length, 1, "one per file, not one per finding");
  assert.equal(core.calls.warnings.length, 0, "the file's warning rides on its error annotation");
  const [e] = core.calls.errors;
  assert.equal(e.title, "BR-DE-15 (BT-10) and 2 more: 2 errors, 1 warning");
  assert.equal(e.startLine, 2, "the first finding's line");
  assert.match(e.message, /\nAlso in this file:\n- BR-CL-14 \(BT-40\), line 24: The seller country code must be an ISO 3166-1 code\.\n/);
  assert.match(e.message, /\n- BR-CL-01 \(BT-5, BT-6\): Currency should be an ISO 4217 code\.\n/);
  assert.doesNotMatch(e.message, /BR-X-01/, "informational findings are never annotated");
  assert.match(e.message, /The job summary lists every finding with its fix\.$/);
});

test("the job-summary pointer is left out when there is no job summary", () => {
  const a = fileAnnotation({ file: "b.xml", findings: [fatal, country] }, { summary: false });
  assert.doesNotMatch(a.message, /job summary/);
});

test("a PDF's annotation claims no line of the PDF and names the line in its attachment", () => {
  const a = fileAnnotation({ file: "x.pdf", syntax: "cii", container: "factur-x.xml", findings: [subset, inPdf] });
  assert.equal(a.level, "error");
  assert.equal(a.properties.startLine, undefined);
  assert.equal(a.properties.title, "AW-PROFILE-SUBSET (BT-24) and 1 more: 2 errors",
    "the finding that explains the others leads");
  assert.match(a.message, /- BR-16 \(BG-25\), near line 103 of factur-x\.xml: An invoice must have at least one invoice line \(BG-25\)\./);
});

test("a file with only warnings gets one ::warning; information alone gets nothing", () => {
  const core = fakeCore();
  emitAnnotations([
    { file: "w.xml", findings: [warning, { ...warning, rule: "BR-CL-02" }] },
    { file: "i.xml", findings: [info] },
  ], core);
  assert.equal(core.calls.errors.length, 0);
  assert.equal(core.calls.warnings.length, 1);
  assert.equal(core.calls.warnings[0].title, "BR-CL-01 (BT-5, BT-6) and 1 more: 2 warnings");
});

test("GitHub shows ten per step: nine files get an error, the failure message is the tenth, the rest are logged", () => {
  const failing = Array.from({ length: 12 }, (_, i) => ({ file: `f${i}.xml`, findings: [fatal] }));
  const warned = Array.from({ length: 11 }, (_, i) => ({ file: `w${i}.xml`, findings: [warning] }));
  const core = fakeCore();
  const shown = emitAnnotations([...failing, ...warned], core);
  assert.equal(core.calls.errors.length, ANNOTATIONS_PER_STEP - 1);
  assert.equal(core.calls.warnings.length, ANNOTATIONS_PER_STEP);
  assert.deepEqual(shown, { annotated: 19, notAnnotated: 4 });
  assert.deepEqual(core.calls.info, [
    "error: f9.xml:2: BR-DE-15 (BT-10)",
    "error: f10.xml:2: BR-DE-15 (BT-10)",
    "error: f11.xml:2: BR-DE-15 (BT-10)",
    "warning: w10.xml: BR-CL-01 (BT-5, BT-6)",
  ]);
});

test("an annotation stays inside GitHub's 4,096 characters and says how many it left out", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ ...country, rule: `BR-CL-${i}` }));
  const a = fileAnnotation({ file: "big.xml", findings: [fatal, ...many] });
  assert.ok(a.message.length <= 4096, `message is ${a.message.length} characters`);
  const listed = a.message.split("\n").filter((l) => l.startsWith("- BR-CL-")).length;
  assert.ok(listed > 5, "as many as fit are listed");
  assert.match(a.message, new RegExp(`\\n- and ${400 - listed} more\\n`));
  assert.equal(a.properties.title, "BR-DE-15 (BT-10) and 400 more: 401 errors");
});

test("annotations: nothing for a file with no findings", () => {
  assert.equal(fileAnnotation({ file: "a.xml", findings: [] }), null);
});

// --- summary -----------------------------------------------------------------

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

// --- SARIF -------------------------------------------------------------------

const many = [
  results[0],
  results[1],
  { file: "invoices/c.xml", syntax: "ubl", profile: "xrechnung-ubl", container: null, findings: [fatal, country] },
  { file: "invoices/m.pdf", syntax: "cii", profile: "en16931", container: "factur-x.xml", findings: [subset, inPdf] },
  { file: "junk.xml", syntax: null, profile: null, container: null, findings: [synthetic] },
];

test("SARIF is ONE run however many documents — the shape upload-sarif accepts", () => {
  const log = buildSarif(many, { engineVersion: "0.10.0", generatedAt: "2026-09-24T00:00:00Z" });
  assert.equal(log.version, "2.1.0");
  assert.match(log.$schema, /sarif-schema-2\.1\.0\.json$/);
  assert.equal(log.runs.length, 1);
  assert.deepEqual(schemaErrors(log), []);
  assert.deepEqual(uploadErrors(log), []);
});

test("every document examined is an artifact of the run, the clean ones included", () => {
  const [run] = buildSarif(many, { engineVersion: "0.10.0" }).runs;
  assert.deepEqual(run.artifacts.map((a) => a.location.uri),
    ["invoices/a.xml", "invoices/b.xml", "invoices/c.xml", "invoices/m.pdf", "junk.xml"]);
  assert.deepEqual(run.artifacts[3].properties, { syntax: "cii", profile: "en16931", container: "factur-x.xml" });
  assert.deepEqual(run.artifacts[4].roles, ["analysisTarget"]);
  assert.equal(run.artifacts[4].properties, undefined, "an unreadable file has no syntax or profile to state");
});

test("each result points at its own document and its own rule", () => {
  const [run] = buildSarif(many, { engineVersion: "0.10.0" }).runs;
  assert.equal(run.results.length, 8, "b: 3, c: 2, m.pdf: 2, junk: 1");
  const byFile = run.results.map((r) => r.locations[0].physicalLocation.artifactLocation);
  assert.deepEqual(byFile.map((l) => l.index), [1, 1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id),
    ["BR-DE-15", "BR-CL-01", "BR-X-01", "BR-CL-14", "AW-PROFILE-SUBSET", "BR-16", "AW-PARSE"],
    "a rule that fired in two documents is described once");
  assert.equal(run.results[3].ruleId, "BR-DE-15");
  assert.equal(run.results[3].ruleIndex, 0, "c.xml's BR-DE-15 refers to the descriptor b.xml's created");
});

test("SARIF regions carry the line the engine read, and only for a line of that file", () => {
  const [run] = buildSarif(many, { engineVersion: "0.10.0" }).runs;
  const region = (i) => run.results[i].locations[0].physicalLocation.region;
  assert.deepEqual(region(3), { startLine: 2, startColumn: 1 }, "c.xml BR-DE-15: nearest element");
  assert.deepEqual(region(4), { startLine: 24, startColumn: 11 }, "c.xml BR-CL-14: the element itself");
  assert.equal(region(6), undefined, "m.pdf BR-16 is on line 103 of factur-x.xml, not of the PDF");
  assert.equal(region(7), undefined, "junk.xml: a finding about the whole file");
  assert.equal(run.results[6].locations[0].logicalLocations[0].fullyQualifiedName, inPdf.xpath,
    "the element's path still says where");
});

test("SARIF levels map fatal→error, warning→warning, information→note", () => {
  const [run] = buildSarif([results[1]], { engineVersion: "0.7.0" }).runs;
  assert.deepEqual(run.results.map((r) => r.level), ["error", "warning", "note"]);
});

test("SARIF carries the rule id, the xpath as a logical location, a helpUri and the engine version", () => {
  const [run] = buildSarif([results[1]], { engineVersion: "0.7.0" }).runs;
  const [first] = run.results;
  assert.equal(first.ruleId, "BR-DE-15");
  assert.equal(first.locations[0].logicalLocations[0].fullyQualifiedName, "/ubl:Invoice/cbc:BuyerReference");
  assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, "invoices/b.xml");
  const { driver } = run.tool;
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
  assert.deepEqual(uploadErrors(log), []);
});

test("the run sets no category of its own, so upload-sarif's `category` input applies", () => {
  const [run] = buildSarif(many, { engineVersion: "0.10.0" }).runs;
  assert.equal(run.automationDetails, undefined);
});

test("file names become URIs: segments percent-encoded, slashes kept", () => {
  assert.equal(fileUri("invoices/2026 Q1/Rechnung #7.xml"), "invoices/2026%20Q1/Rechnung%20%237.xml");
  assert.equal(fileUri("100%.xml"), "100%25.xml", "upload-sarif decodes URIs, and a bare % throws there");
  assert.equal(fileUri("a/b.xml"), "a/b.xml");
  const log = buildSarif([{ file: "in voices/a b.xml", findings: [fatal] }], { engineVersion: "0.10.0" });
  assert.equal(log.runs[0].artifacts[0].location.uri, "in%20voices/a%20b.xml");
  assert.deepEqual(uploadErrors(log), []);
});

test("negative control: the checks refuse what upload-sarif refuses", () => {
  // Exactly what 1.3.0 wrote: the engine's single-run log per document, runs
  // concatenated, every one with the same tool and category. upload-sarif
  // rejects it, so the check must too, or passing it proves nothing.
  const perDocument = {
    ...buildSarif([], { engineVersion: "0.10.0" }),
    runs: many.map((r) => toSarif(r.findings, {
      engineVersion: "0.10.0", profile: r.profile ?? undefined, documentUri: r.file,
      suiteName: "validate-einvoice-action",
    }).runs[0]),
  };
  assert.deepEqual(schemaErrors(perDocument), [], "schema-valid, which is why it went unnoticed");
  assert.match(uploadErrors(perDocument).join("\n"), /runs\[1\] has the tool and category of an earlier run/);

  const [run] = buildSarif(many, { engineVersion: "0.10.0" }).runs;
  const tooMany = { ...perDocument, runs: Array.from({ length: 21 }, (_, i) => ({ ...run, automationDetails: { id: `c${i}/` } })) };
  assert.deepEqual(uploadErrors(tooMany), ["21 runs; code scanning takes at most 20 per file"]);

  const misspelt = buildSarif(many, { engineVersion: "0.10.0" });
  misspelt.runs[0].results[0].levle = "error";
  assert.match(schemaErrors(misspelt).join("\n"), /unexpected property "levle"/);

  const badLevel = buildSarif(many, { engineVersion: "0.10.0" });
  badLevel.runs[0].results[0].level = "fatal";
  assert.match(schemaErrors(badLevel).join("\n"), /not in enum/);

  const badRegion = buildSarif(many, { engineVersion: "0.10.0" });
  badRegion.runs[0].results[3].locations[0].physicalLocation.region = { startColumn: 1 };
  assert.match(schemaErrors(badRegion).join("\n"), /matched no anyOf branch/);

  const crossed = buildSarif(many, { engineVersion: "0.10.0" });
  crossed.runs[0].results[0].ruleIndex = 3;
  crossed.runs[0].results[1].locations[0].physicalLocation.artifactLocation.index = 0;
  const errors = uploadErrors(crossed).join("\n");
  assert.match(errors, /ruleIndex 3 is not BR-DE-15/);
  assert.match(errors, /artifact index 0 is not invoices\/b\.xml/);
});
