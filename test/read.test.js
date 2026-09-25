/**
 * The reader: one file in, findings out.
 *
 * The interesting assertions here are the negative ones. A validator that
 * cannot tell a conformant invoice from a broken one is useless; a validator
 * that quietly reports nothing for a file it could not open is worse than
 * useless, because the build goes green. Both are pinned below, and so is
 * where each finding is: the line in the file, in the file's own syntax.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateFile } from "../src/read.js";
import { FIXTURES, pdfWithAttachment } from "./helpers.js";

const fixture = (name) => path.join(FIXTURES, name);
const encoded = (name) => path.join(FIXTURES, "encodings", name);

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

test("a finding carries the line it is about: a missing element, at the element it belongs in", async () => {
  const [f] = (await validateFile(fixture("xrechnung-ubl-missing-buyer-reference.xml"))).findings;
  assert.equal(f.xpath, "/ubl:Invoice/cbc:BuyerReference");
  assert.deepEqual(f.location, { line: 2, column: 1, path: "/ubl:Invoice", exact: false });
});

test("a CII document's finding has a CII path and a CII line, not the UBL path the rule is written in", async () => {
  const r = await validateFile(fixture("xrechnung-cii-missing-buyer-reference.xml"));
  assert.equal(r.syntax, "cii");
  assert.equal(r.findings.length, 1);
  const [f] = r.findings;
  assert.equal(f.rule, "BR-DE-15");
  assert.equal(f.xpath,
    "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeAgreement/ram:BuyerReference");
  assert.equal(f.location.line, 72, "<ram:ApplicableHeaderTradeAgreement>, where BT-10 belongs");
  assert.equal(f.location.exact, false);
});

test("a Factur-X PDF is unwrapped and its CII payload validated", async () => {
  const r = await validateFile(fixture("facturx-en16931-einfach.pdf"));
  assert.equal(r.syntax, "cii");
  assert.equal(r.container, "factur-x.xml");
  assert.deepEqual(r.findings, []);
});

test("a Factur-X MINIMUM PDF says why it fails before the rules it fails, located in its attachment", async () => {
  const r = await validateFile(fixture("facturx-minimum-rechnung.pdf"));
  assert.equal(r.container, "factur-x.xml");
  assert.deepEqual(r.findings.map((f) => f.rule), ["AW-PROFILE-SUBSET", "BR-10", "BR-11", "BR-16", "BR-12"]);
  assert.ok(r.findings.every((f) => f.severity === "fatal"));
  assert.match(r.findings[0].message, /MINIMUM carries too little to be an EN 16931 invoice/);
  for (const f of r.findings.slice(1)) {
    assert.equal(f.location.attachment, "factur-x.xml", `${f.rule}: its line is the attachment's, not the PDF's`);
  }
});

test("a PDF is recognised by its bytes, whatever the file is called", async () => {
  const renamed = path.join(await mkdtemp(path.join(tmpdir(), "einvoice-read-")), "saved-by-a-mail-client.xml");
  await copyFile(fixture("facturx-en16931-einfach.pdf"), renamed);
  const r = await validateFile(renamed);
  assert.equal(r.container, "factur-x.xml");
  assert.deepEqual(r.findings, []);
});

test("a file named .pdf that is not a PDF is told so, even when it is a valid invoice", async () => {
  const misnamed = path.join(await mkdtemp(path.join(tmpdir(), "einvoice-read-")), "invoice.pdf");
  await copyFile(fixture("xrechnung-ubl-minimal.xml"), misnamed);
  const r = await validateFile(misnamed);
  assert.equal(r.syntax, null);
  assert.equal(r.findings.length, 1);
  const [f] = r.findings;
  assert.equal(f.rule, "AW-PDF");
  assert.equal(f.severity, "fatal");
  assert.equal(f.field, "document");
  assert.match(f.message,
    /invoice\.pdf could not be read as a Factur-X \/ ZUGFeRD PDF: it is named \.pdf, but it does not begin with %PDF-/);
});

test("an ISO-8859-1 invoice is read in the encoding it declares, not as UTF-8", async () => {
  const file = encoded("xrechnung-ubl-iso-8859-1.xml");
  assert.ok((await readFile(file)).toString("utf8").includes("\uFFFD"),
    "the fixture really is Latin-1: decoded as UTF-8, as this reader once did, its umlauts are U+FFFD");
  const r = await validateFile(file);
  assert.equal(r.syntax, "ubl");
  assert.equal(r.profile, "xrechnung-ubl");
  // The fixture's one flaw is a display name in the seller's email address,
  // and BR-DE-28 quotes the address back: the quote is the text the rules saw.
  assert.deepEqual(r.findings.map((f) => `${f.rule}:${f.severity}`), ["BR-DE-28:warning"]);
  assert.match(r.findings[0].message, /"Jürgen Weiß <rechnungen@musterlieferant\.example>"/);
  assert.doesNotMatch(JSON.stringify(r), /\uFFFD/);
});

test("a UTF-16 invoice is read, not refused as malformed", async () => {
  const file = encoded("xrechnung-cii-utf-16.xml");
  assert.deepEqual([...(await readFile(file)).subarray(0, 2)], [0xff, 0xfe], "UTF-16LE, with its byte-order mark");
  const r = await validateFile(file);
  assert.equal(r.syntax, "cii");
  assert.equal(r.profile, "xrechnung-cii");
  assert.deepEqual(r.findings, []);
});

test("a PDF whose attached XML is not UTF-8 is refused by name, not judged with U+FFFD in it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "einvoice-read-"));
  const utf8 = path.join(dir, "utf8-attachment.pdf");
  const latin1 = path.join(dir, "latin1-attachment.pdf");
  await writeFile(utf8, pdfWithAttachment(await readFile(fixture("xrechnung-ubl-minimal.xml"))));
  await writeFile(latin1, pdfWithAttachment(await readFile(encoded("xrechnung-ubl-iso-8859-1.xml"))));

  const control = await validateFile(utf8);
  assert.equal(control.container, "factur-x.xml");
  assert.deepEqual(control.findings, [], "the same PDF around a UTF-8 attachment reads, and passes");

  // Engines before 0.12.0 read this with "M\uFFFDnchen" in it, and it passed
  // with one warning. The engine now refuses the attachment, naming its
  // encoding, and the finding is the engine's own.
  const r = await validateFile(latin1);
  assert.equal(r.container, "factur-x.xml");
  assert.deepEqual(r.findings.map((f) => `${f.rule}:${f.severity}`), ["AW-PARSE:fatal"]);
  assert.match(r.findings[0].message, /The XML attached as "factur-x\.xml" is in iso-8859-1, not UTF-8/);
  assert.doesNotMatch(JSON.stringify(r), /\uFFFD/);
});

test("XML that is not an invoice is a fatal finding, never a silent pass", async () => {
  const r = await validateFile(fixture("not-an-invoice.xml"));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "AW-PARSE");
  assert.equal(r.findings[0].severity, "fatal");
  assert.match(r.findings[0].message, /not an invoice/);
  assert.match(r.findings[0].message, /<not-an-invoice>/, "names the root element it found");
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

test("a profile of the other syntax is judged, and draws a warning saying so", async () => {
  const r = await validateFile(fixture("xrechnung-ubl-minimal.xml"), { profile: "xrechnung-cii" });
  const [w] = r.findings.filter((f) => f.severity === "warning");
  assert.equal(w.rule, "AW-PROFILE-SYNTAX");
});

test("max-characters refuses an oversized document rather than parsing it, and names the input", async () => {
  const r = await validateFile(fixture("xrechnung-ubl-minimal.xml"), { maxCharacters: 100 });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "AW-SIZE");
  assert.equal(r.findings[0].severity, "fatal");
  assert.match(r.findings[0].message, /over the 100 character limit/);
  assert.match(r.findings[0].fix, /max-characters input/, "the knob this action has, not the library's option");
});
