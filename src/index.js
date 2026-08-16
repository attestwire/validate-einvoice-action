/**
 * Entry point. Everything of substance is in `src/run.js`; this file exists to
 * hand it the real `@actions/core` and to make sure a thrown error becomes a
 * failed step with a readable sentence rather than an unhandled rejection.
 *
 * No top-level `await`: this module is bundled to CommonJS by ncc, where top-
 * level await does not exist, and a build that silently changed the entry
 * point's module format would be a strange thing to depend on.
 */

import * as core from "@actions/core";
import { run } from "./run.js";

run(core).catch((err) => {
  core.setFailed(err?.message ?? String(err));
});
