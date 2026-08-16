/**
 * One document in, one verdict out — locally, in the runner.
 *
 * This module owns the two decisions the rest of the action does not want to
 * make: which reader an XML file goes to, and what a file we could not read at
 * all looks like once it reaches the report. The second one matters more than
 * it sounds. A pipeline that silently skips the invoice it could not parse is
 * worse than one that has no validation in it, because it reports green for a
 * file nobody has ever looked at. Every failure path here therefore produces a
 * FINDING, in the same shape as a rule violation, and that finding is fatal.
 *
 * The syntax probe mirrors `apps/api/src/xml-document.js` deliberately: the
 * root element is read once by the library's own parser and compared by
 * namespace, rather than the reader being guessed from the file extension or
 * from a substring search. A file named `.xml` that turns out to be HTML is
 * then refused by `parseUbl` with the library's own message, naming the root it
 * found, instead of by a regex here with a worse one.
 */

import { readFile } from "node:fs/promises";
import {
  CII_NAMESPACES,
  extractFacturX,
  parseCiiInvoice,
  parseUblInvoice,
  parseXml,
  validateInput,
} from "@attestwire/en16931";

/** Profiles the `profile` input may name. Rejected early, with the list. */
export const PROFILES = Object.freeze([
  "en16931",
  "xrechnung-ubl",
  "xrechnung-cii",
  "facturx-en16931",
  "peppol-bis-3",
]);

/**
 * A finding for something that went wrong before any rule could run.
 *
 * Same shape as a `TeachingError`, so the SARIF writer, the annotation writer
 * and the summary table need no special case. `docsUrl` is deliberately absent:
 * there is no rule page for "your file is not an invoice", and inventing a link
 * that 404s would be worse than having none.
 */
export function unreadable(rule, message, fix) {
  return { rule, field: "document", severity: "fatal", message, fix };
}

/** Is this a `ParseError` from the engine, including across module realms? */
function isParseFailure(err) {
  return /^(xml_|unsupported_|pdf_|facturx_)/.test(String(err?.code ?? ""));
}

/** CII is the narrow case; everything else goes to the UBL reader. */
function syntaxOf(xml, limits) {
  const root = parseXml(xml, limits);
  return root.namespace === CII_NAMESPACES.rsm &&
    root.local === "CrossIndustryInvoice"
    ? "cii"
    : "ubl";
}

/**
 * Read a file into XML, unwrapping a Factur-X / ZUGFeRD PDF when it is one.
 *
 * The PDF branch is chosen by extension rather than by sniffing bytes, because
 * a `.pdf` that is not a PDF should be told so in those words. `extractFacturX`
 * pulls the embedded CII payload out; validating that payload is not validating
 * the PDF container, and the summary says as much.
 */
async function readDocument(file) {
  const bytes = await readFile(file);
  if (/\.pdf$/i.test(file)) {
    const { xml, attachmentName } = extractFacturX(new Uint8Array(bytes));
    return { xml, container: attachmentName ?? "embedded XML" };
  }
  return { xml: bytes.toString("utf8"), container: null };
}

/**
 * Validate one file locally.
 *
 * `profile` overrides the profile the document declares. That is an override
 * and not a filter: with it set, a Peppol document is judged against, say,
 * XRechnung rules and will fail rules it was never meant to satisfy. Off by
 * default for exactly that reason.
 *
 * @returns {Promise<{file: string, syntax: string|null, profile: string|null,
 *   container: string|null, findings: object[]}>}
 */
export async function validateFile(file, { profile = "", maxCharacters = null } = {}) {
  const base = { file, syntax: null, profile: null, container: null };
  const limits = maxCharacters ? { maxCharacters } : undefined;

  let xml, container;
  try {
    ({ xml, container } = await readDocument(file));
  } catch (err) {
    if (isParseFailure(err)) {
      return {
        ...base,
        findings: [
          unreadable(
            "AW-PDF",
            `${file} could not be read as a Factur-X / ZUGFeRD PDF: ${err.message}`,
            "Check the file is a PDF/A-3 with an EN 16931 CII attachment, or validate the XML payload directly.",
          ),
        ],
      };
    }
    return {
      ...base,
      findings: [
        unreadable(
          "AW-IO",
          `${file} could not be read: ${err?.message ?? String(err)}`,
          "Check the path and the runner's permissions on it.",
        ),
      ],
    };
  }

  let syntax, parsed;
  try {
    syntax = syntaxOf(xml, limits);
    parsed =
      syntax === "cii"
        ? parseCiiInvoice(xml, limits)
        : parseUblInvoice(xml, limits);
  } catch (err) {
    if (!isParseFailure(err)) throw err;
    return {
      ...base,
      container,
      findings: [
        unreadable(
          "AW-PARSE",
          `${file} is not a document this validator can read: ${err.message}`,
          "Supply a UBL 2.1 Invoice/CreditNote or a UN/CEFACT CrossIndustryInvoice. " +
            "If the file is large, raise max-characters.",
        ),
      ],
    };
  }

  const invoice = profile ? { ...parsed.invoice, profile } : parsed.invoice;
  const result = validateInput(invoice);

  return {
    file,
    syntax,
    container,
    profile: result.profile,
    findings: [...result.errors, ...result.warnings, ...result.information],
  };
}
