/**
 * The engine version this action ships, stated once.
 *
 * A constant rather than a read of `@attestwire/en16931/package.json`, because
 * the bundle has no `node_modules` to read at runtime and a version reported
 * from an absent file is worse than no version at all. The obvious failure —
 * bumping the dependency and forgetting this line — is caught by
 * `test/version.test.js`, which compares this string against both the installed
 * package and the exact pin in our own `package.json`.
 */
export const ENGINE_VERSION = "0.9.0";

/** Name reported in the SARIF driver and the summary. */
export const ENGINE_NAME = "@attestwire/en16931";
