/**
 * The reader: one file in, findings out.
 *
 * The interesting assertions here are the negative ones. A validator that
 * cannot tell a conformant invoice from a broken one is useless; a validator
 * that quietly reports nothing for a file it could not open is worse than
 * useless, because the build goes green. Both are pinned below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateFile } from "../src/read.js";
import { FIXTURES } from "./helpers.js";

const fixture = (name) => path.join(FIXTURES, name);

test("a conformant XRechnung UBL invoice produces no findings", async () => {
  const r = await validateFile(fixture("xrechnung-ubl-minimal.xml"));
  assert.equal(r.syntax, "ubl");
  assert.equal(r.profile, "xrechnung-ubl");
  assert.deepEqual(r.findings, []);
});

test("a conformant XRechnung CII invoice is routed to the CII reader", async () => {
  const r = await validateFile(fixture("xrechnung-cii-minimal.xml"));
  assert.equal(r.syntax, "cii");
  assert.equal(r.profile, "xrechnung-cii");
  assert.deepEqual(r.findings, []);
});

test("a UBL credit note is read as a document, not refused as a non-invoice", async () => {
  const r = await validateFile(fixture("xrechnung-ubl-credit-note.xml"));
  assert.equal(r.syntax, "ubl");
  assert.deepEqual(r.findings, []);
});

test("a missing Leitweg-ID is a fatal BR-DE-15 with a fix and a rule page", async () => {
  const r = await validateFile(fixture("xrechnung-ubl-missing-buyer-reference.xml"));
  assert.equal(r.findings.length, 1);
  const [f] = r.findings;
  assert.equal(f.rule, "BR-DE-15");
  assert.equal(f.severity, "fatal");
  assert.equal(f.field, "BT-10");
  assert.match(f.docsUrl, /attestwire\.com\/rules\/BR-DE-15$/);
  assert.ok(f.fix.length > 0, "a finding without a fix teaches nothing");
});

test("a Factur-X PDF is unwrapped and its CII payload validated", async () => {
  const r = await validateFile(fixture("facturx-en16931-einfach.pdf"));
  assert.equal(r.syntax, "cii");
  assert.equal(r.container, "factur-x.xml");
  assert.deepEqual(r.findings, []);
});

test("XML that is not an invoice is a fatal finding, never a silent pass", async () => {
  const r = await validateFile(fixture("not-an-invoice.xml"));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "AW-PARSE");
  assert.equal(r.findings[0].severity, "fatal");
  assert.match(r.findings[0].message, /not-an-invoice\.xml/);
});

test("a file that does not exist is a fatal finding, never a silent pass", async () => {
  const r = await validateFile(fixture("nothing-here.xml"));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "AW-IO");
  assert.equal(r.findings[0].severity, "fatal");
});

test("the profile input overrides the profile the document declares", async () => {
  // Judged against Peppol rather than XRechnung, the German-specific rule that
  // fires above does not apply — which is exactly what an override means, and
  // why it is off by default.
  const r = await validateFile(fixture("xrechnung-ubl-missing-buyer-reference.xml"), {
    profile: "peppol-bis-3",
  });
  assert.equal(r.profile, "peppol-bis-3");
  assert.ok(!r.findings.some((f) => f.rule === "BR-DE-15"));
});

test("max-characters refuses an oversized document rather than parsing it", async () => {
  const r = await validateFile(fixture("xrechnung-ubl-minimal.xml"), { maxCharacters: 100 });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "AW-PARSE");
  assert.equal(r.findings[0].severity, "fatal");
});
