/**
 * One document in, one verdict out — locally, in the runner.
 *
 * The engine's `validate(bytes)` makes every decision about the file: whether
 * it is a Factur-X / ZUGFeRD PDF (by its first bytes, not its name), which
 * encoding the XML is in (its byte-order mark, then its declaration), whether
 * it is UBL or CII, which profile it claims, and, when it is none of those,
 * what it actually is: an HTML page, a ZIP archive, JSON. No reader is chosen
 * here and nothing is decoded here. That used to be done in this module, from
 * the file's extension and `bytes.toString("utf8")`, and the decoding was the
 * bug: an ISO-8859-1 invoice reached the rules with every umlaut replaced by
 * U+FFFD, and could pass, while a UTF-16 one could not be read at all. The
 * hosted validator hands the same bytes to the same call (api mode now sends
 * the file as it is; see api.js), so the two modes cannot read a file
 * differently.
 *
 * What the engine adds over the older parse-then-`validateInput` path is where
 * each finding is: a `location` with the line of the element in the file, and
 * an `xpath` in the file's own syntax (CII paths for a CII file, not the UBL
 * paths the rules are written in).
 *
 * What stays here is what the engine cannot see: a file the runner could not
 * open, and a file whose name says PDF when its bytes do not. Each becomes a
 * FINDING in the same shape as a rule violation, and it is fatal. A pipeline
 * that silently skips the invoice it could not open is worse than one that has
 * no validation in it, because it reports green for a file nobody has ever
 * looked at. (A PDF whose attached XML is not UTF-8 is the engine's to refuse:
 * since 0.12.0 `validate` answers it with a fatal AW-PARSE naming the
 * encoding, where 0.10.0 and 0.11.0 decoded the attachment with replacement
 * characters.)
 */

import { readFile } from "node:fs/promises";
import { validate } from "@attestwire/en16931";

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
 * Same shape as the engine's own `AW-` findings, so the SARIF writer, the
 * annotation writer and the summary table need no special case. `docsUrl` is
 * deliberately absent: there is no rule page for "your file is not an
 * invoice", and inventing a link that 404s would be worse than having none.
 */
export function unreadable(rule, message, fix) {
  return { rule, field: "document", severity: "fatal", message, fix };
}

/** Is this a PDF? By its first four bytes, `%PDF`: the test `validate` applies. */
export function isPdf(bytes) {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * A file named `.pdf` that is not a PDF, as a finding; null for any other file.
 *
 * The engine goes by the bytes, so it would read such a file as whatever it
 * turns out to be, and the verdict would be about a document the workflow did
 * not know it had: an HTML login page a download step saved as `invoice.pdf`,
 * or XML under the wrong name. The name is the one fact about a file that only
 * the runner has, so the runner checks it, and a `.pdf` that is not a PDF is
 * told so in those words. Both modes ask this first, so a file gets the same
 * answer from either.
 */
export function pdfInNameOnly(file, bytes) {
  if (!/\.pdf$/i.test(file) || isPdf(bytes)) return null;
  return unreadable(
    "AW-PDF",
    `${file} could not be read as a Factur-X / ZUGFeRD PDF: it is named .pdf, but it does not begin ` +
      "with %PDF-, so it is not a PDF.",
    "Check the file is a PDF/A-3 with an EN 16931 CII attachment, or validate the XML payload directly.",
  );
}

/**
 * The engine's fix for an oversized document names its own `limits` option.
 * In this action that limit is the `max-characters` input, so say that; the
 * other size limits (element count, PDF streams) have no input here, and the
 * engine's sentence is left as it is.
 */
function inActionTerms(finding, error) {
  if (finding.rule === "AW-SIZE" && error?.code === "xml_too_large") {
    return { ...finding, fix: "If a document this size is expected, raise the max-characters input." };
  }
  return finding;
}

/**
 * Validate one file locally.
 *
 * `profile` overrides the profile the document declares. That is an override
 * and not a filter: with it set, a Peppol document is judged against, say,
 * XRechnung rules and will fail rules it was never meant to satisfy. Off by
 * default for exactly that reason. A profile of the other syntax draws the
 * engine's `AW-PROFILE-SYNTAX` warning.
 *
 * @returns {Promise<{file: string, syntax: string|null, profile: string|null,
 *   container: string|null, findings: object[]}>}
 */
export async function validateFile(file, { profile = "", maxCharacters = null } = {}) {
  const base = { file, syntax: null, profile: null, container: null };

  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
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

  const misnamed = pdfInNameOnly(file, bytes);
  if (misnamed) return { ...base, findings: [misnamed] };

  const result = validate(bytes, {
    ...(profile ? { profile } : {}),
    ...(maxCharacters ? { limits: { maxCharacters } } : {}),
  });
  const read = { file, syntax: result.syntax, container: result.container, profile: result.profile };


  return {
    ...read,
    findings: [...result.errors, ...result.warnings, ...result.information]
      .map((f) => inActionTerms(f, result.error)),
  };
}
