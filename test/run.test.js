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
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInputs, run } from "../src/run.js";
import { FIXTURES, fakeCore, fakeFetch } from "./helpers.js";

const inFixtures = (pattern) => path.join(FIXTURES, pattern);

// --- inputs ------------------------------------------------------------------

test("an unknown profile is refused, with the list of what is accepted", () => {
  assert.throws(() => readInputs(fakeCore({ profile: "zugferd" })), /not a profile this engine knows/);
});

test("an unknown fail-on is refused rather than defaulting to error", () => {
  assert.throws(() => readInputs(fakeCore({ "fail-on": "never" })), /is not valid/);
});

test("a non-numeric max-characters is refused", () => {
  assert.throws(() => readInputs(fakeCore({ "max-characters": "lots" })), /positive whole number/);
});

test("record without api-key is refused, and the message says why", () => {
  assert.throws(() => readInputs(fakeCore({ record: "true" })), /needs api-key/);
});

test("supplying api-key is what selects api mode; nothing else does", () => {
  assert.equal(readInputs(fakeCore({})).mode, "local");
  assert.equal(readInputs(fakeCore({ "api-key": "aw_live_x" })).mode, "api");
});

test("summary and annotations default on, record defaults off", () => {
  const i = readInputs(fakeCore({}));
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

test("a non-conformant invoice fails the step, annotates the file and counts the error", async () => {
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-missing-buyer-reference.xml") });
  await run(core);
  assert.match(core.calls.failed, /1 error/);
  assert.equal(core.calls.outputs.valid, "false");
  assert.equal(core.calls.outputs["error-count"], "1");
  assert.equal(core.calls.errors.length, 1);
  assert.equal(core.calls.errors[0].title, "BR-DE-15 (BT-10)");
});

test("a glob validates every match and the file count says how many", async () => {
  const core = fakeCore({ files: inFixtures("*.xml") });
  await run(core);
  assert.equal(core.calls.outputs["file-count"], "5");
  assert.equal(core.calls.outputs["error-count"], "2", "the broken invoice and the non-invoice");
});

test("exclusion patterns are honoured, one pattern per line", async () => {
  const core = fakeCore({
    files: [inFixtures("*.xml"), `!${inFixtures("not-an-invoice.xml")}`,
            `!${inFixtures("xrechnung-ubl-missing-buyer-reference.xml")}`].join("\n"),
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

test("api mode posts the document as XML with a bearer key", async () => {
  const fetchImpl = fakeFetch([apiOk]);
  const core = fakeCore({ files: inFixtures("xrechnung-ubl-minimal.xml"), "api-key": "aw_live_x" });
  await run(core, { fetchImpl });

  assert.equal(fetchImpl.seen.length, 1);
  const [{ url, init }] = fetchImpl.seen;
  assert.equal(url, "https://api.attestwire.com/v1/validate");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/xml");
  assert.equal(init.headers.authorization, "Bearer aw_live_x");
  assert.match(init.body, /^<\?xml/);
  assert.equal(core.calls.failed, null);
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

test("a PDF is unwrapped locally in api mode and only its XML payload is sent", async () => {
  const fetchImpl = fakeFetch([apiOk]);
  const core = fakeCore({
    files: inFixtures("facturx-en16931-einfach.pdf"), "api-key": "aw_live_x",
  });
  await run(core, { fetchImpl });
  assert.match(fetchImpl.seen[0].init.body, /CrossIndustryInvoice/);
  assert.ok(!fetchImpl.seen[0].init.body.startsWith("%PDF"));
});
