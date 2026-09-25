/**
 * api mode — the same engine, reached over HTTP instead of out of node_modules.
 *
 * WHY THIS MODE EXISTS AT ALL, given the library is already bundled. Two things
 * the runner cannot do for itself:
 *
 *   1. **Current rules.** The bundled library is pinned, on purpose — see the
 *      README section on rule-set stability. A pinned library answers with the
 *      rule set you chose; the hosted validator always answers with the current
 *      one, and returns a `provenance` block naming it. Teams that would rather
 *      find out about a new rule from a red build than from a rejected invoice
 *      want this mode.
 *   2. **Validation Records.** A record is a third-party-checkable artefact:
 *      the fingerprint of the document, the verdict, the rule set, the date, at
 *      a URL somebody outside your CI can open. A runner cannot mint one about
 *      itself and have it mean anything.
 *
 * THE FILE IS SENT AS IT IS, byte for byte: a PDF as `application/pdf`, any
 * other file as `application/xml`, with no `charset`. The hosted validator
 * hands the bytes to the same `validate()` local mode calls, so it unwraps the
 * PDF, decodes the XML in the encoding the file declares, and names a file that
 * is not an invoice, exactly as the runner would. This mode used to decode
 * every file as UTF-8 and post the text, still declaring the encoding it was no
 * longer in: an ISO-8859-1 invoice arrived with every umlaut replaced by
 * U+FFFD and could pass, and a UTF-16 one could not be read. It also unwrapped
 * a PDF itself and posted only the XML. Sending the file instead means a
 * Validation Record fingerprints the file in the repository, not a payload
 * extracted from it.
 *
 * The header chooses the validator's door, a document rather than the JSON
 * invoice model, and a body under a header that door does not take is answered
 * 415 `unsupported_media_type`. So it is chosen from the bytes, by the test the
 * engine applies, and not from the file's name.
 *
 * Failures here are findings, never exceptions: a 401, a quota exhaustion or a
 * DNS failure produces a fatal finding against the file, so a broken key gives
 * a red build with a sentence explaining it rather than a stack trace.
 */

import { readFile } from "node:fs/promises";
import { isPdf, pdfInNameOnly, unreadable } from "./read.js";

/** Requests that fail below the HTTP layer are retried; a 4xx verdict is not. */
const RETRIES = 2;
const RETRY_DELAY_MS = 750;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the request URL, carrying only the parameters the caller actually set. */
export function validateUrl(base, { record = false, maxCharacters = null } = {}) {
  const url = new URL("/v1/validate", base);
  if (record) url.searchParams.set("record", "true");
  if (maxCharacters) url.searchParams.set("max_characters", String(maxCharacters));
  return url.toString();
}

/**
 * POST one document, with retries on transport faults and 5xx only.
 *
 * `fetch` is Node 20's own; there is no HTTP client in this action's bundle.
 */
async function post(url, bytes, contentType, apiKey, fetchImpl) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": contentType,
          authorization: `Bearer ${apiKey}`,
          "user-agent": "attestwire/validate-einvoice-action",
        },
        body: bytes,
      });
      if (response.status < 500) return { ok: true, response };
      last = `HTTP ${response.status}`;
    } catch (err) {
      last = err?.message ?? String(err);
    }
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
  }
  return { ok: false, reason: last };
}

/**
 * Validate one file through the hosted validator.
 *
 * Returns the same record shape `validateFile` does, plus `recordUrl` and
 * `provenance` when the response carried them.
 */
export async function validateFileViaApi(
  file,
  { apiKey, apiUrl, record = false, maxCharacters = null, profile = "", fetchImpl = fetch } = {},
) {
  const base = { file, syntax: null, profile: null, container: null };

  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return {
      ...base,
      findings: [
        unreadable("AW-IO", `${file} could not be read: ${err?.message ?? String(err)}`,
          "Check the path and the runner's permissions on it."),
      ],
    };
  }

  // The validator is never told the file's name, so a `.pdf` that is not a
  // PDF is answered here, in the words local mode uses, and costs no request.
  const misnamed = pdfInNameOnly(file, bytes);
  if (misnamed) return { ...base, findings: [misnamed] };

  const pdf = isPdf(bytes);
  const url = validateUrl(apiUrl, { record, maxCharacters });
  const sent = await post(url, bytes, pdf ? "application/pdf" : "application/xml", apiKey, fetchImpl);
  if (!sent.ok) {
    return {
      ...base,
      findings: [
        unreadable("AW-NETWORK",
          `${file} could not be validated: the request to ${apiUrl} failed (${sent.reason}).`,
          "Retry the job, or drop api-key to fall back to the bundled local validator."),
      ],
    };
  }

  const { response } = sent;
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = body?.message ?? `HTTP ${response.status}`;
    return {
      ...base,
      findings: [
        unreadable("AW-API",
          `${file} was refused by the validator (HTTP ${response.status}): ${message}`,
          response.status === 401 || response.status === 403
            ? "Check the api-key secret. Remove it to run the bundled local validator instead, which needs no key."
            : "See https://api.attestwire.com/docs for this status."),
      ],
    };
  }

  // For a PDF the validator names the attachment it read the XML from, and
  // each finding's line is a line of that XML, not of the PDF. Every location
  // is marked with the name, which keeps it off the PDF in the annotations and
  // the SARIF regions even if a response left a location unmarked; if one ever
  // named no attachment at all, the engine's own words for one stand in.
  const container = body?.container ?? (pdf ? "embedded XML" : null);
  const inPayload = (f) =>
    container !== null && f?.location ? { ...f, location: { ...f.location, attachment: container } } : f;
  const findings = [
    ...(body?.errors ?? []),
    ...(body?.warnings ?? []),
    ...(body?.information ?? []),
  ].map(inPayload);

  // `profile` is echoed from the engine's own result, not from our input, for
  // the same reason the API echoes it: a document that declared nothing was
  // judged against `en16931`, and saying otherwise would hide that.
  return {
    file,
    container,
    syntax: body?.syntax ?? null,
    profile: body?.profile ?? profile ?? null,
    findings,
    recordUrl: body?.record?.url ?? null,
    recordUnavailable: body?.record_unavailable?.message ?? null,
    provenance: body?.provenance ?? null,
  };
}
