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
 * A PDF is unwrapped LOCALLY even in this mode, and the extracted CII payload
 * is what gets posted. The hosted endpoint reads XML documents, not PDF
 * containers, and the extraction is a pure function in the bundled library —
 * shipping the whole PDF over the wire to have it refused would be slower and
 * less private for no gain.
 *
 * Failures here are findings, never exceptions: a 401, a quota exhaustion or a
 * DNS failure produces a fatal finding against the file, so a broken key gives
 * a red build with a sentence explaining it rather than a stack trace.
 */

import { readFile } from "node:fs/promises";
import { extractFacturX } from "@attestwire/en16931";
import { unreadable } from "./read.js";

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
async function post(url, xml, apiKey, fetchImpl) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/xml",
          authorization: `Bearer ${apiKey}`,
          "user-agent": "attestwire/validate-einvoice-action",
        },
        body: xml,
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

  let xml, container = null;
  try {
    const bytes = await readFile(file);
    if (/\.pdf$/i.test(file)) {
      const extracted = extractFacturX(new Uint8Array(bytes));
      xml = extracted.xml;
      container = extracted.attachmentName ?? "embedded XML";
    } else {
      xml = bytes.toString("utf8");
    }
  } catch (err) {
    return {
      ...base,
      findings: [
        unreadable("AW-IO", `${file} could not be read: ${err?.message ?? String(err)}`,
          "Check the path and the runner's permissions on it."),
      ],
    };
  }

  const url = validateUrl(apiUrl, { record, maxCharacters });
  const sent = await post(url, xml, apiKey, fetchImpl);
  if (!sent.ok) {
    return {
      ...base,
      container,
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
      container,
      findings: [
        unreadable("AW-API",
          `${file} was refused by the validator (HTTP ${response.status}): ${message}`,
          response.status === 401 || response.status === 403
            ? "Check the api-key secret. Remove it to run the bundled local validator instead, which needs no key."
            : "See https://api.attestwire.com/docs for this status."),
      ],
    };
  }

  const findings = [
    ...(body?.errors ?? []),
    ...(body?.warnings ?? []),
    ...(body?.information ?? []),
  ];

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
