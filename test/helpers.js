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
