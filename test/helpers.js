/**
 * A fake `@actions/core` that records instead of printing.
 *
 * The real one writes workflow commands to stdout and outputs to a file named
 * by an environment variable, which makes assertions about a run either
 * stdout-scraping or filesystem archaeology. This records the same calls as
 * data, so a test can say "this run emitted exactly one ::error, against this
 * file, naming this rule" in one line.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, "fixtures");

export function fakeCore(inputs = {}) {
  const calls = {
    errors: [], warnings: [], info: [], debug: [],
    outputs: {}, failed: null, summary: "",
  };
  const core = {
    getInput: (name) => inputs[name] ?? "",
    setOutput: (name, value) => { calls.outputs[name] = value; },
    setFailed: (message) => { calls.failed = message; },
    error: (message, props) => calls.errors.push({ message, ...props }),
    warning: (message, props) => calls.warnings.push({ message, ...props }),
    info: (message) => calls.info.push(message),
    debug: (message) => calls.debug.push(message),
    summary: {
      addRaw(text) { calls.summary += text; return this; },
      async write() { return this; },
    },
    calls,
  };
  return core;
}

/**
 * The smallest Factur-X-shaped PDF: `xml` (bytes) attached as `name`, the way
 * Factur-X registers it, in the EmbeddedFiles name tree and in /AF, stored
 * without compression, behind a classic cross-reference table.
 *
 * For the one case no conformant producer's sample shows, an attachment in an
 * encoding other than UTF-8. Whether a real file reads is a question for the
 * FeRD samples in fixtures/, not for this.
 */
export function pdfWithAttachment(xml, name = "factur-x.xml") {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(${name}) 4 0 R] >> >> /AF [4 0 R] >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    `<< /Type /Filespec /F (${name}) /UF (${name}) /AFRelationship /Alternative /EF << /F 5 0 R >> >>`,
    [`<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${xml.length} >>\nstream\n`, xml, "\nendstream"],
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
  const size = () => parts.reduce((n, p) => n + p.length, 0);
  objects.forEach((object, i) => {
    offsets.push(size());
    for (const part of [`${i + 1} 0 obj\n`, ...[object].flat(), "\nendobj\n"]) {
      parts.push(typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part));
    }
  });
  const xref = size();
  parts.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    "latin1",
  ));
  return Buffer.concat(parts);
}

/** A `fetch` that answers every request from a queue, and records what it got. */
export function fakeFetch(responses) {
  const seen = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(url, init);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  impl.seen = seen;
  return impl;
}
