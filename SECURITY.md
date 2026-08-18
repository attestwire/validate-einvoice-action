# Security

## Reporting

Email **hello@attestwire.com**. The maintainer reads these directly.

Include what you found, how to reproduce it, and the Action version or commit
you were on. Please don't open a public issue for a security report.

There's no bug bounty. If you'd like credit, say so and you'll be named in the
release notes for the fix.

## Scope

Two things this Action touches make it worth a careful look:

**The API key.** In api mode the key comes in as a GitHub secret. Anything that
could put it somewhere it doesn't belong is a security issue — the job log, the
job summary, an annotation, an error message, the SARIF report, a crash dump, or
an outbound request to a host other than the configured `api-url`.

**Your invoice documents.** In api mode the XML is POSTed to the Attestwire API.
Invoices carry customer names, addresses, VAT IDs and bank details. Report
anything that sends document contents somewhere unintended, or that leaks them
into output visible to more people than the person who ran the job.

Also in scope:

- A crafted invoice file, or a crafted `files` pattern, that reads outside the
  workspace or writes outside the paths the Action is meant to write.
- Anything that lets file contents or an input string execute as a command or
  inject workflow commands into the runner's output stream.
- Anything in local mode that makes a network call. Local mode shouldn't make
  any.

## Out of scope

A wrong verdict is a bug. Report it at
[attestwire/en16931](https://github.com/attestwire/en16931/issues), where the
validation logic lives.

Vulnerabilities in the rule engine itself (XML parsing, entity expansion, the
PDF reader) belong in that repository's
[SECURITY.md](https://github.com/attestwire/en16931/blob/main/SECURITY.md)
process, same email either way.
