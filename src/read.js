/**
 * One document in, one verdict out — locally, in the runner.
 *
 * The engine's `validate(bytes)` makes every decision about the file: whether
 * it is a Factur-X / ZUGFeRD PDF (by its first bytes, not its name), which
 * encoding the XML declares, whether it is UBL or CII, and which profile it
 * claims. It is the same call the engine's command line and the hosted API
 * make, so the three cannot disagree about a file. What it adds over the older
 * parse-then-`validateInput` path is where each finding is: a `location` with
 * the line of the element in the file, and an `xpath` in the file's own syntax
 * (CII paths for a CII file, not the UBL paths the rules are written in).
 *
 * What stays here is the part the engine cannot see: a file the runner could
 * not read at all. That, like every other failure, becomes a FINDING in the
 * same shape as a rule violation, and it is fatal. A pipeline that silently
 * skips the invoice it could not open is worse than one that has no validation
 * in it, because it reports green for a file nobody has ever looked at.
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
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return {
      file, syntax: null, profile: null, container: null,
      findings: [
        unreadable(
          "AW-IO",
          `${file} could not be read: ${err?.message ?? String(err)}`,
          "Check the path and the runner's permissions on it.",
        ),
      ],
    };
  }

  const result = validate(bytes, {
    ...(profile ? { profile } : {}),
    ...(maxCharacters ? { limits: { maxCharacters } } : {}),
  });

  return {
    file,
    syntax: result.syntax,
    container: result.container,
    profile: result.profile,
    findings: [...result.errors, ...result.warnings, ...result.information]
      .map((f) => inActionTerms(f, result.error)),
  };
}
