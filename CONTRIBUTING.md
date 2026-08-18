# Contributing

This repository is developed in the open, so the normal GitHub flow applies:
fork it, branch, open a pull request. No CLA, no template to sign.

## Where your issue belongs

The Action is a thin wrapper. It finds files, hands them to the rule engine,
and turns findings into annotations, a job summary and SARIF. **The verdicts
come from [`@attestwire/en16931`](https://github.com/attestwire/en16931).**

So:

- A rule that fired when it shouldn't have, a rule that stayed quiet, a document
  that won't parse — that's the engine. Report it at
  [attestwire/en16931](https://github.com/attestwire/en16931/issues), with the
  XML and the rule ID you expected.
- Globbing, inputs, exit codes, annotations, the job summary, SARIF output, api
  mode — that's here.

If you're not sure which, open it here and it'll get moved.

## Running the tests

Node 20 or newer.

```bash
npm install
npm test          # node --test, over test/
npm run build     # ncc bundle into dist/
npm run all       # build then test
```

To run one file:

```bash
node --test test/run.test.js
```

## Before you open the PR

**Commit `dist/`.** GitHub runs the bundled `dist/index.js`, not `src/`, so a
change to `src/` that isn't rebuilt does nothing on a real runner. Run
`npm run all` and include the rebuilt bundle in the commit.

Add a test. The suite covers reading files, running validation, and rendering
reports, so there's usually an obvious file to extend. If your change affects
what the Action outputs, `test/e2e.test.js` is the one to look at.

Keep the engine pinned to an exact version in `package.json`. Reproducible
verdicts are the point of local mode: a given tag of this Action has to run
exactly the same rules a year from now. Bumping the engine is its own PR.

## Questions

Open an issue, or email hello@attestwire.com.

Security issues go to hello@attestwire.com. See [SECURITY.md](SECURITY.md).

## Licence

MIT. By contributing, you agree your contribution ships under it.
