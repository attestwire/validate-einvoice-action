/**
 * The three places this action describes itself — `action.yml`, the code, and
 * the README — kept in agreement by a test rather than by discipline.
 *
 * A GitHub Action has a failure mode no library has: an input documented in
 * `action.yml` but never read is accepted silently and does nothing, and an
 * input read but not declared is *warned about* by the runner and then also
 * does nothing. Both look like a working configuration to the person who wrote
 * the workflow. So the sets are compared here, in both directions, and the
 * README is held to the same list.
 *
 * `action.yml` is read with a deliberately small parser instead of a YAML
 * dependency: it needs to find two-space-indented keys under two known
 * top-level maps, and a dependency in `devDependencies` to do that would be a
 * supply-chain entry bought for one regex.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { ENGINE_VERSION } from "../src/version.js";
import { HERE } from "./helpers.js";

const ROOT = path.join(HERE, "..");
const read = (...p) => readFile(path.join(ROOT, ...p), "utf8");

/** Keys of the two-space-indented map under a top-level `section:` key. */
function sectionKeys(yaml, section) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `${section}:`);
  assert.notEqual(start, -1, `action.yml has no ${section}: section`);
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

test("engine version is stated once and matches the pin and the install", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const pin = pkg.dependencies["@attestwire/en16931"];
  assert.equal(pin, ENGINE_VERSION, "the dependency must be pinned to an exact version, not a range");
  assert.ok(!/[\^~]/.test(pin), "a caret here would make two runs of the same action tag disagree");

  const require = createRequire(import.meta.url);
  const installed = require("@attestwire/en16931/package.json").version;
  assert.equal(installed, ENGINE_VERSION, "run npm install; src/version.js and node_modules disagree");
});

test("action.yml declares a node24 action pointing at the built bundle", async () => {
  const yaml = await read("action.yml");
  assert.match(yaml, /using: "node24"/);
  assert.match(yaml, /main: "dist\/index\.js"/);
});

test("action.yml carries marketplace branding", async () => {
  const yaml = await read("action.yml");
  assert.match(yaml, /icon: "check-circle"/);
  assert.match(yaml, /color: "blue"/);
});

test("the marketplace description is inside GitHub's 125-character limit", async () => {
  const yaml = await read("action.yml");
  const description = /^description: "([^"]+)"$/m.exec(yaml)?.[1];
  assert.ok(description, "action.yml needs a single-line quoted description");
  assert.ok(description.length <= 125, `description is ${description.length} characters`);
});

test("every declared input is read by the code, and every input read is declared", async () => {
  const yaml = await read("action.yml");
  const declared = new Set(sectionKeys(yaml, "inputs"));

  const src = await readdir(path.join(ROOT, "src"));
  const code = (await Promise.all(src.map((f) => read("src", f)))).join("\n");
  const used = new Set([...code.matchAll(/getInput\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));

  assert.deepEqual([...used].filter((i) => !declared.has(i)), [],
    "read but not declared: the runner warns and the input does nothing");
  assert.deepEqual([...declared].filter((i) => !used.has(i)), [],
    "declared but never read: accepted silently and does nothing");
});

test("every declared output is set by the code, and every output set is declared", async () => {
  const yaml = await read("action.yml");
  const declared = new Set(sectionKeys(yaml, "outputs"));

  const code = await read("src", "run.js");
  const set = new Set([...code.matchAll(/setOutput\("([a-z0-9-]+)"/g)].map((m) => m[1]));

  assert.deepEqual([...set].filter((o) => !declared.has(o)), []);
  assert.deepEqual([...declared].filter((o) => !set.has(o)), []);
});

test("defaults in action.yml match the fallbacks the code applies", async () => {
  const yaml = await read("action.yml");
  const run = await read("src", "run.js");
  for (const [input, value] of [["files", "**/*.xml"], ["fail-on", "error"], ["api-url", "https://api.attestwire.com"]]) {
    assert.ok(yaml.includes(`default: "${value}"`), `action.yml default for ${input}`);
    assert.ok(run.includes(`"${value}"`), `src/run.js fallback for ${input}`);
  }
  assert.match(yaml, /default: "true"/, "summary and annotations default on");
  assert.match(yaml, /default: "false"/, "record defaults off");
});

test("the README documents every input and every output", async () => {
  const yaml = await read("action.yml");
  const readme = await read("README.md");
  for (const name of [...sectionKeys(yaml, "inputs"), ...sectionKeys(yaml, "outputs")]) {
    assert.ok(readme.includes(`\`${name}\``), `README does not mention \`${name}\``);
  }
});

test("the README states the pinned engine version it actually ships", async () => {
  const readme = await read("README.md");
  assert.ok(readme.includes(`@attestwire/en16931@${ENGINE_VERSION}`),
    "the version-stability claim is only credible if the stated version is the shipped one");
});

test("the README's quickstart uses the action's own name and a pinned ref", async () => {
  const readme = await read("README.md");
  assert.match(readme, /uses: attestwire\/validate-einvoice-action@v1/);
});
