/**
 * What GitHub code scanning would refuse in a SARIF file, checked without
 * GitHub.
 *
 * `github/codeql-action/upload-sarif` does two things with a file before it
 * sends it: validates it against the SARIF 2.1.0 JSON schema, and refuses it if
 * two of its runs share a tool and a category ("multiple SARIF runs with the
 * same category", enforced since July 2025). Code scanning then takes at most
 * 20 runs per file and 25,000 results per run. This action's CI ran none of
 * that — it wrote a SARIF file and never uploaded it — which is how a report
 * with one run per document shipped. These checks are the upload's, run in the
 * test suite, so they hold on every operating system and on a fork's pull
 * request, where the real upload has no permission to run.
 *
 * The schema is the normative OASIS file (provenance in fixtures/README.md).
 * upload-sarif validates against a copy of it that differs only in carrying
 * the region's `anyOf` as a property, which disables that one check, so
 * passing this is at least as strict. The validator is the JSON Schema subset
 * the engine's own export tests use, ported: every keyword the schema uses,
 * and no others, and zero dependencies.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES } from "./helpers.js";

const schema = JSON.parse(readFileSync(path.join(FIXTURES, "sarif-schema-2.1.0.json"), "utf8"));

function resolveRef(ref) {
  if (!ref.startsWith("#/definitions/")) throw new Error(`unexpected non-local $ref: ${ref}`);
  const def = schema.definitions?.[ref.slice("#/definitions/".length)];
  if (!def) throw new Error(`unresolvable $ref: ${ref}`);
  return def;
}

function typeMatches(value, type) {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    default: throw new Error(`unknown type keyword: ${type}`);
  }
}

function check(value, node, at) {
  if (node.$ref) return check(value, resolveRef(node.$ref), at);
  const errors = [];

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => typeMatches(value, t))) return [`${at}: expected ${types.join("|")}`];
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === "string" && node.pattern && !new RegExp(node.pattern).test(value)) {
    errors.push(`${at}: does not match ${node.pattern}`);
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${at}: below minimum`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${at}: fewer than ${node.minItems} items`);
    }
    if (node.uniqueItems === true) {
      const seen = value.map((v) => JSON.stringify(v));
      if (new Set(seen).size !== seen.length) errors.push(`${at}: items are not unique`);
    }
    if (node.items) value.forEach((item, i) => errors.push(...check(item, node.items, `${at}[${i}]`)));
  }
  if (typeMatches(value, "object")) {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (node.properties?.[key]) errors.push(...check(child, node.properties[key], `${at}.${key}`));
      else if (node.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
      else if (typeof node.additionalProperties === "object") {
        errors.push(...check(child, node.additionalProperties, `${at}.${key}`));
      }
    }
  }
  for (const key of ["oneOf", "anyOf"]) {
    if (!node[key]) continue;
    const passing = node[key].filter((branch) => check(value, branch, at).length === 0).length;
    if (key === "anyOf" && passing === 0) errors.push(`${at}: matched no anyOf branch`);
    if (key === "oneOf" && passing !== 1) errors.push(`${at}: matched ${passing} oneOf branches, expected 1`);
  }
  return errors;
}

/** Every way `log` fails the SARIF 2.1.0 schema; empty means valid. */
export function schemaErrors(log) {
  return check(log, schema, "$");
}

/**
 * Everything upload-sarif and code scanning would refuse, and every reference
 * inside the file that points at the wrong thing; empty means uploadable.
 *
 * The run key is upload-sarif's own (`createRunKey` in codeql-action's
 * src/sarif): the driver's name, full name, version, semantic version and
 * guid, and `automationDetails.id`.
 */
export function uploadErrors(log) {
  const errors = schemaErrors(log);
  const runs = log.runs ?? [];
  if (runs.length > 20) errors.push(`${runs.length} runs; code scanning takes at most 20 per file`);

  const keys = new Set();
  runs.forEach((run, r) => {
    const d = run.tool?.driver ?? {};
    const key = JSON.stringify([d.name, d.fullName, d.version, d.semanticVersion, d.guid, run.automationDetails?.id]);
    if (keys.has(key)) errors.push(`runs[${r}] has the tool and category of an earlier run`);
    keys.add(key);

    const results = run.results ?? [];
    if (results.length > 25000) errors.push(`runs[${r}] has ${results.length} results; the limit is 25,000`);
    results.forEach((result, i) => {
      const rule = d.rules?.[result.ruleIndex];
      if (result.ruleIndex !== undefined && rule?.id !== result.ruleId) {
        errors.push(`runs[${r}].results[${i}]: ruleIndex ${result.ruleIndex} is not ${result.ruleId}`);
      }
      const where = result.locations?.[0]?.physicalLocation?.artifactLocation;
      if (where?.index !== undefined && run.artifacts?.[where.index]?.location?.uri !== where.uri) {
        errors.push(`runs[${r}].results[${i}]: artifact index ${where.index} is not ${where.uri}`);
      }
    });
  });
  return errors;
}
