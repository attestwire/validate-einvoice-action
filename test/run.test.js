/**
 * The action end to end, driven through a fake `core`.
 *
 * Every assertion here is about something a workflow author can observe: an
 * output, a failure message, a written file. Input validation gets its own
 * block because a mistyped input that silently falls back to a default is the
 * one bug class that turns this action into decoration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInputs, run } from "../src/run.js";
import { FIXTURES, fakeCore, fakeFetch } from "./helpers.js";
import { uploadErrors } from "./sarif-check.js";

const inFixtures = (pattern) => path.join(FIXTURES, pattern);

// --- inputs ------------------------------------------------------------------

const withFiles = (inputs = {}) => fakeCore({ files: "invoices/**/*.xml", ...inputs });

test("files is required: there is no default, and the refusal says what to write", () => {
  for (const files of [undefined, "", "  \n "]) {
    assert.throws(() => readInputs(fakeCore(files === undefined ? {} : { files })),
      /files: is required\. Name your invoices, one glob per line, for example `invoices\/\*\*\/\*\.xml`/);
  }
  assert.throws(() => readInputs(fakeCore({})), /pom\.xml/, "and why a repository-wide glob is not the answer");
});

test("an unknown profile is refused, with the list of what is accepted", () => {
  assert.throws(() => readInputs(withFiles({ profile: "zugferd" })), /not a profile this engine knows/);
});

test("an unknown fail-on is refused rather than defaulting to error", () => {
  assert.throws(() => readInputs(withFiles({ "fail-on": "never" })), /is not valid/);
});

test("a non-numeric max-characters is refused", () => {
  assert.throws(() => readInputs(withFiles({ "max-characters": "lots" })), /positive whole number/);
});

test("record without api-key is refused, and the message says why", () => {
  assert.throws(() => readInputs(withFiles({ record: "true" })), /needs api-key/);
});

test("supplying api-key is what selects api mode; nothing else does", () => {
  assert.equal(readInputs(withFiles()).mode, "local");
  assert.equal(readInputs(withFiles({ "api-key": "aw_live_x" })).mode, "api");
});

test("summary and annotations default on, record defaults off", () => {
  const i = readInputs(withFiles());
  assert.equal(i.summary, true);
  assert.equal(i.annotations, true);
  assert.equal(i.record, false);
  assert.equal(i.failOn, "error");
});

// --- local mode --------------------------------------------------------------

test("a clean invoice passes, sets outputs and does not fail the step", async () => {
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml") });
  await run(core);
  assert.equal(core.calls.failed, null);
  assert.deepEqual(core.calls.outputs, {
    valid: "true", "error-count": "0", "warning-count": "0", "file-count": "1",
    "sarif-path": "", "record-urls": "",
  });
});

test("a non-conformant invoice fails the step, annotates the file on its line and counts the error", async () => {
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-missing-buyer-reference.xml") });
  await run(core);
  assert.match(core.calls.failed, /1 error/);
  assert.equal(core.calls.outputs.valid, "false");
  assert.equal(core.calls.outputs["error-count"], "1");
  assert.equal(core.calls.errors.length, 1);
  assert.equal(core.calls.errors[0].title, "BR-DE-15 (BT-10)");
  assert.equal(core.calls.errors[0].startLine, 2, "<Invoice>, where the missing BuyerReference belongs");
});

test("a CII invoice is annotated on its own line, with its own path", async () => {
  const core = fakeCore({ files: inFixtures("xrechnung-cii-missing-buyer-reference.xml") });
  await run(core);
  const [e] = core.calls.errors;
  assert.equal(e.startLine, 72);
  assert.match(e.message, /At: \/rsm:CrossIndustryInvoice\/rsm:SupplyChainTradeTransaction\/ram:ApplicableHeaderTradeAgreement\/ram:BuyerReference /);
  assert.doesNotMatch(e.message, /\/ubl:/);
});

test("a Factur-X MINIMUM PDF is one annotation that says why, counts five, and claims no line of the PDF", async () => {
  const core = fakeCore({ files: inFixtures("facturx-minimum-rechnung.pdf") });
  await run(core);
  assert.equal(core.calls.outputs["error-count"], "5");
  assert.equal(core.calls.errors.length, 1, "one annotation for the file");
  const [e] = core.calls.errors;
  assert.equal(e.title, "AW-PROFILE-SUBSET (BT-24) and 4 more: 5 errors");
  assert.equal(e.startLine, undefined);
  assert.match(e.message, /^This is a Factur-X MINIMUM document\./);
  assert.match(e.message, /- BR-16 \(BG-25\), near line \d+ of factur-x\.xml: /);
});

test("a glob validates every match and the file count says how many", async () => {
  const core = fakeCore({ files: inFixtures("*.xml") });
  await run(core);
  assert.equal(core.calls.outputs["file-count"], "6");
  assert.equal(core.calls.outputs["error-count"], "3", "the two broken invoices and the non-invoice");
  assert.equal(core.calls.errors.length, 3, "one annotation per failing file");
});

test("exclusion patterns are honoured, one pattern per line", async () => {
  const core = fakeCore({
    files: [inFixtures("*.xml"), `!${inFixtures("not-an-invoice.xml")}`,
            `!${inFixtures("*-missing-buyer-reference.xml")}`].join("\n"),
  });
  await run(core);
  assert.equal(core.calls.failed, null);
  assert.equal(core.calls.outputs["file-count"], "3");
});

test("a pattern that matches nothing FAILS — a run over zero files proves nothing", async () => {
  const core = fakeCore({ files: inFixtures("no-such-*.xml") });
  await run(core);
  assert.match(core.calls.failed, /matched/);
  assert.equal(core.calls.outputs.valid, "false");
  assert.equal(core.calls.outputs["file-count"], "0");
});

test("fail-on warning gates on warnings too", async () => {
  const clean = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "fail-on": "warning" });
  await run(clean);
  assert.equal(clean.calls.failed, null, "a document with no warnings still passes");
});

test("summary: true writes a job summary; summary: false writes none", async () => {
  const on = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml") });
  await run(on);
  assert.match(on.calls.summary, /Validate E-Invoice \(EN 16931\)/);

  const off = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), summary: "false" });
  await run(off);
  assert.equal(off.calls.summary, "");
});

test("annotations: false suppresses the workflow commands but not the verdict", async () => {
  const core = fakeCore({
    files: inFixtures("xrechnung-ubl-missing-buyer-reference.xml"), annotations: "false",
  });
  await run(core);
  assert.equal(core.calls.errors.length, 0);
  assert.equal(core.calls.outputs["error-count"], "1");
  assert.ok(core.calls.failed);
});

test("the sarif input writes a SARIF 2.1.0 log and reports its path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "einvoice-action-"));
  const core = fakeCore({
    files: inFixtures("xrechnung-ubl-missing-buyer-reference.xml"),
    sarif: path.join(dir, "reports", "einvoice.sarif"),
  });
  await run(core);

  const written = core.calls.outputs["sarif-path"];
  assert.equal(written, path.join(dir, "reports", "einvoice.sarif"));
  const log = JSON.parse(await readFile(written, "utf8"));
  assert.equal(log.version, "2.1.0");
  assert.equal(log.runs.length, 1);
  assert.equal(log.runs[0].results.length, 1);
  assert.equal(log.runs[0].results[0].ruleId, "BR-DE-15");
  assert.equal(log.runs[0].results[0].level, "error");
  assert.equal(log.runs[0].tool.driver.name, "@attestwire/en16931");
  assert.match(log.runs[0].artifacts[0].location.uri, /missing-buyer-reference\.xml$/);
});

test("the SARIF for many documents is one run, and upload-sarif's checks pass on it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "einvoice-action-"));
  const core = fakeCore({
    files: `${inFixtures("*.xml")}\n${inFixtures("*.pdf")}`,
    sarif: path.join(dir, "einvoice.sarif"),
  });
  await run(core);
  const log = JSON.parse(await readFile(core.calls.outputs["sarif-path"], "utf8"));
  assert.equal(core.calls.outputs["file-count"], "8");
  assert.equal(log.runs.length, 1, "one run, not one per document");
  assert.equal(log.runs[0].artifacts.length, 8, "every document, the clean ones too");
  assert.deepEqual(uploadErrors(log), []);
  const regions = log.runs[0].results.map((r) => r.locations[0].physicalLocation.region?.startLine ?? null);
  assert.deepEqual(regions, [null, null, null, null, null, null, 72, 2],
    "the MINIMUM PDF's five (lines in its attachment), the non-invoice (no line), CII line 72, UBL line 2");
});

test("more failing files than GitHub will annotate: the failure message says how many were only logged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "einvoice-many-"));
  for (let i = 0; i < 12; i++) {
    await copyFile(inFixtures("xrechnung-ubl-missing-buyer-reference.xml"), path.join(dir, `inv-${String(i).padStart(2, "0")}.xml`));
  }
  const core = fakeCore({ files: path.join(dir, "*.xml") });
  await run(core);
  assert.equal(core.calls.errors.length, 9);
  assert.equal(core.calls.info.filter((l) => /^error: .*inv-\d+\.xml:2: BR-DE-15/.test(l)).length, 3);
  assert.equal(core.calls.failed,
    "12 errors and 0 warnings across 12 documents (fail-on: error). 3 more files with findings are listed in the log, " +
      "not annotated: GitHub shows ten annotations of each kind per step. The job summary has every finding.");
});

test("reported paths are repo-relative, not absolute runner paths", async () => {
  const core = fakeCore({ files: "test/fixtures/xrechnung-ubl-missing-buyer-reference.xml" });
  await run(core, { cwd: process.cwd() });
  assert.equal(core.calls.errors[0].file, "test/fixtures/xrechnung-ubl-missing-buyer-reference.xml");
});

// --- api mode ----------------------------------------------------------------

const apiOk = {
  status: 200,
  body: {
    valid: true, profile: "xrechnung-ubl", errors: [], warnings: [], information: [],
    syntax: "ubl",
    provenance: { engine: "@attestwire/en16931", engine_version: "0.7.0", ruleset: "attestwire-2026-08" },
    record: { id: "abc123", url: "https://api.attestwire.com/r/abc123", json: "https://api.attestwire.com/r/abc123.json" },
  },
};

test("api mode posts the file's bytes as XML with a bearer key", async () => {
  const fetchImpl = fakeFetch([apiOk]);
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x" });
  await run(core, { fetchImpl });

  assert.equal(fetchImpl.seen.length, 1);
  const [{ url, init }] = fetchImpl.seen;
  assert.equal(url, "https://api.attestwire.com/v1/validate");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/xml");
  assert.equal(init.headers.authorization, "Bearer aw_live_x");
  assert.deepEqual(init.body, await readFile(inFixtures("xrechnung-ubl-minimal.xml")));
  assert.equal(core.calls.failed, null);
});

test("api mode sends an ISO-8859-1 or UTF-16 invoice as it is, for the validator to decode", async () => {
  for (const name of ["xrechnung-ubl-iso-8859-1.xml", "xrechnung-cii-utf-16.xml"]) {
    const file = path.join(FIXTURES, "encodings", name);
    const fetchImpl = fakeFetch([apiOk]);
    await run(fakeCore({ files: file, "api-key": "aw_live_x" }), { fetchImpl });
    const [{ init }] = fetchImpl.seen;
    assert.equal(init.headers["content-type"], "application/xml",
      `${name}: no charset parameter, so the encoding the file declares decides`);
    assert.deepEqual(init.body, await readFile(file), `${name}: the bytes on disk, not text re-encoded as UTF-8`);
  }
});

test("api mode sends a Factur-X PDF whole, as application/pdf, whatever the file is called", async () => {
  const pdf = inFixtures("facturx-en16931-einfach.pdf");
  const renamed = path.join(await mkdtemp(path.join(tmpdir(), "einvoice-api-")), "saved-by-a-mail-client.xml");
  await copyFile(pdf, renamed);
  for (const file of [pdf, renamed]) {
    const fetchImpl = fakeFetch([apiOk]);
    await run(fakeCore({ files: file, "api-key": "aw_live_x" }), { fetchImpl });
    const [{ init }] = fetchImpl.seen;
    assert.equal(init.headers["content-type"], "application/pdf", `${path.basename(file)}: chosen by the bytes`);
    assert.deepEqual(init.body, await readFile(pdf), "the PDF itself, for the validator to unwrap");
  }
});

test("api mode answers a .pdf that is not a PDF itself, in local mode's words, and sends nothing", async () => {
  const misnamed = path.join(await mkdtemp(path.join(tmpdir(), "einvoice-api-")), "invoice.pdf");
  await copyFile(inFixtures("xrechnung-ubl-minimal.xml"), misnamed);
  const fetchImpl = fakeFetch([apiOk]);
  const core = fakeCore({ files: misnamed, "api-key": "aw_live_x" });
  await run(core, { fetchImpl });
  assert.equal(fetchImpl.seen.length, 0);
  assert.equal(core.calls.outputs["error-count"], "1");
  assert.equal(core.calls.errors[0].title, "AW-PDF (document)");
  assert.match(core.calls.errors[0].message, /could not be read as a Factur-X \/ ZUGFeRD PDF: it is named \.pdf/);
});

test("record: true asks for a record and surfaces the URL as an output", async () => {
  const fetchImpl = fakeFetch([apiOk]);
  const core = fakeCore({
    files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x", record: "true",
  });
  await run(core, { fetchImpl });
  assert.match(fetchImpl.seen[0].url, /\?record=true$/);
  assert.equal(core.calls.outputs["record-urls"], "https://api.attestwire.com/r/abc123");
  assert.match(core.calls.summary, /Validation Record: https:/);
});

test("max-characters is passed to the hosted parser", async () => {
  const fetchImpl = fakeFetch([apiOk]);
  const core = fakeCore({
    files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x", "max-characters": "900000",
  });
  await run(core, { fetchImpl });
  assert.match(fetchImpl.seen[0].url, /max_characters=900000/);
});

test("api mode reports findings the hosted validator returned", async () => {
  const fetchImpl = fakeFetch([{
    status: 200,
    body: {
      valid: false, profile: "xrechnung-ubl", syntax: "ubl",
      errors: [{ rule: "BR-DE-15", field: "BT-10", severity: "fatal", message: "m", fix: "f",
                 docsUrl: "https://attestwire.com/rules/BR-DE-15" }],
      warnings: [], information: [],
      provenance: { engine_version: "0.7.0", ruleset: "attestwire-2026-08" },
    },
  }]);
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x" });
  await run(core, { fetchImpl });
  assert.equal(core.calls.outputs["error-count"], "1");
  assert.match(core.calls.summary, /attestwire-2026-08/);
});

test("a rejected key is a fatal finding naming the fallback, not a stack trace", async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: "unauthorized", message: "No such key." } }]);
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "nope" });
  await run(core, { fetchImpl });
  assert.equal(core.calls.outputs["error-count"], "1");
  assert.equal(core.calls.errors[0].title, "AW-API (document)");
  assert.match(core.calls.errors[0].message, /HTTP 401/);
  assert.match(core.calls.errors[0].message, /needs no key/);
});

test("a transport failure is a fatal finding, and the request was retried", async () => {
  let attempts = 0;
  const fetchImpl = fakeFetch([() => { attempts++; throw new Error("ECONNRESET"); }]);
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x" });
  await run(core, { fetchImpl });
  assert.equal(attempts, 3, "one attempt plus two retries");
  assert.equal(core.calls.errors[0].title, "AW-NETWORK (document)");
  assert.ok(core.calls.failed);
});

test("api mode: a line the validator found in a PDF's payload is not claimed as a line of the PDF", async () => {
  const fetchImpl = fakeFetch([{
    status: 200,
    body: {
      valid: false, profile: "en16931", syntax: "cii", container: "factur-x.xml",
      // Unmarked on purpose: the validator marks it, and this is the case
      // where a response did not.
      errors: [{ rule: "BR-16", field: "BG-25", severity: "fatal", message: "m", fix: "f",
                 docsUrl: "https://attestwire.com/rules/BR-16",
                 location: { line: 103, column: 3, path: "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction", exact: false } }],
      warnings: [], information: [],
    },
  }]);
  const dir = await mkdtemp(path.join(tmpdir(), "einvoice-api-"));
  const core = fakeCore({
    files: inFixtures("facturx-en16931-einfach.pdf"), "api-key": "aw_live_x", sarif: path.join(dir, "e.sarif"),
  });
  await run(core, { fetchImpl });
  const [e] = core.calls.errors;
  assert.equal(e.startLine, undefined);
  assert.match(e.message, /line 103 of factur-x\.xml/);
  assert.match(core.calls.summary, /Factur-X payload: factur-x\.xml/, "the attachment the validator named");
  const log = JSON.parse(await readFile(core.calls.outputs["sarif-path"], "utf8"));
  assert.equal(log.runs[0].results[0].locations[0].physicalLocation.region, undefined);
});

test("api mode: a line in an XML document is used as it is", async () => {
  const fetchImpl = fakeFetch([{
    status: 200,
    body: {
      valid: false, profile: "xrechnung-ubl", syntax: "ubl",
      errors: [{ rule: "BR-DE-15", field: "BT-10", severity: "fatal", message: "m", fix: "f",
                 docsUrl: "https://attestwire.com/rules/BR-DE-15",
                 location: { line: 2, column: 1, path: "/ubl:Invoice", exact: false } }],
      warnings: [], information: [],
    },
  }]);
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x" });
  await run(core, { fetchImpl });
  assert.equal(core.calls.errors[0].startLine, 2);
});
