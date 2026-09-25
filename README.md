# Validate E-Invoice (EN 16931)

[![CI](https://github.com/attestwire/validate-einvoice-action/actions/workflows/ci.yml/badge.svg)](https://github.com/attestwire/validate-einvoice-action/actions/workflows/ci.yml)
[![Marketplace](https://img.shields.io/badge/marketplace-validate--e--invoice-blue)](https://github.com/marketplace/actions/validate-e-invoice-en-16931)
[![engine: @attestwire/en16931 0.12.1](https://img.shields.io/badge/engine-%40attestwire%2Fen16931%400.12.1-blue)](https://www.npmjs.com/package/@attestwire/en16931)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Fail the build when an e-invoice would be rejected — before a customer's ERP,
a Peppol access point or a tax authority rejects it for you.**

Validates EN 16931 documents in UBL 2.1 and UN/CEFACT CII — XRechnung, Peppol
BIS Billing 3.0, and the CII payload inside a Factur-X / ZUGFeRD PDF — against
270 rule IDs reachable from caller input. Every finding names the official
rule, the business term it constrains, why the regulation requires it, and the
fix.

**It runs entirely inside the runner by default.** No API key, no account, no
network call, nothing leaves your infrastructure. The rule engine is bundled at
a pinned version, so the same commit gives the same verdict next year.

## Quickstart

```yaml
- uses: actions/checkout@v7
- uses: attestwire/validate-einvoice-action@v1
  with:
    files: |
      invoices/**/*.xml
      invoices/**/*.pdf
```

That is the whole integration. `files` is required and has no default: every
matched file is validated, and a repository-wide `**/*.xml` would also match
`pom.xml` and your IDE's settings, none of which is an invoice. It fails the job
on any fatal finding, annotates each failing file on the pull request at the
line concerned, and writes a findings table to the job summary.

## What it validates

| Input | Read as | Notes |
| --- | --- | --- |
| `.xml` with a UBL `Invoice` or `CreditNote` root | UBL 2.1 | XRechnung UBL, Peppol BIS Billing 3.0 |
| `.xml` with a `CrossIndustryInvoice` root | UN/CEFACT CII | XRechnung CII, Factur-X EN 16931 payload |
| `.pdf` | Factur-X / ZUGFeRD | the embedded CII XML is extracted and validated |

The syntax is decided by the document's root element, not by its filename, so a
`.xml` file that is not an invoice is refused by name rather than skipped. A PDF
is recognised by its bytes, so a Factur-X saved as `.xml` is still read as one;
a file named `.pdf` that is not a PDF is refused as one. XML is decoded in the
encoding it declares (its byte-order mark, then its XML declaration), so an
ISO-8859-1 or UTF-16 invoice is judged with its umlauts intact, and bytes that
are not valid in that encoding fail the file instead of turning into
replacement characters. A Factur-X PDF whose attached XML is not UTF-8 is
refused for the same reason.
A Factur-X MINIMUM or BASIC WL file fails with `AW-PROFILE-SUBSET` ahead of the
rules it cannot meet: those profiles carry too little to be an EN 16931 invoice.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `files` | *(required)* | Glob of the invoice files to validate, one pattern per line. `!` prefixes an exclusion. |
| `profile` | *(from the document)* | Force the profile every document is judged against: `en16931`, `xrechnung-ubl`, `xrechnung-cii`, `facturx-en16931`, `peppol-bis-3`. Local mode only. |
| `fail-on` | `error` | `error` fails on fatal findings; `warning` fails on fatal **or** warning. |
| `api-key` | *(none)* | Supplying it switches to **api mode** (see below). Pass via `secrets`. |
| `record` | `false` | api mode only. Mint a shareable Validation Record per document. |
| `max-characters` | engine default (400,000) | Cap on XML document size. Bigger documents are refused, not truncated. |
| `sarif` | *(none)* | Path to write a SARIF 2.1.0 report to, for the Security tab: one run covering every document. |
| `summary` | `true` | Write the findings table to the job summary. |
| `annotations` | `true` | Emit one `::error` / `::warning` per file, on its line, so findings appear inline on the PR. |
| `api-url` | `https://api.attestwire.com` | Advanced. Base URL of the hosted validator. |

Every input is **checked before any file is opened**. A mistyped `fail-on` or an
unknown `profile` fails the step with the list of accepted values, rather than
falling back to a default and reporting green for a reason nobody can see.

## Outputs

| Output | Example | Description |
| --- | --- | --- |
| `valid` | `false` | `true` when no document produced a fatal finding. |
| `error-count` | `3` | Fatal findings across every document. |
| `warning-count` | `1` | Warning findings across every document. |
| `file-count` | `12` | Documents validated. |
| `sarif-path` | `/…/einvoice.sarif` | Where the SARIF report was written, or empty. |
| `record-urls` | `https://…/r/abc123` | Newline-separated Validation Record URLs, or empty. |

```yaml
- id: invoices
  uses: attestwire/validate-einvoice-action@v1
  with:
    files: "invoices/**/*.xml"
    fail-on: warning
- if: always()
  run: echo "${{ steps.invoices.outputs.error-count }} errors in ${{ steps.invoices.outputs.file-count }} documents"
```

## Exit codes

| Exit | When |
| --- | --- |
| `0` | Every document validated, and nothing crossed the `fail-on` threshold. |
| `1` | A document produced a finding at or above `fail-on`. |
| `1` | A file could not be read, parsed, or is not an invoice. |
| `1` | The `files` pattern matched **nothing**. |
| `1` | An input is missing or invalid, or (api mode) the key was rejected or the API unreachable. |

The last two are deliberate. **A run over zero files is not a pass** — a
pipeline that reports green for invoices nobody looked at is worse than one with
no validation in it — and a file that could not be read is a fatal finding, not
a silent skip. Both fail with a sentence saying which.

Informational findings never fail a build under any setting. A warning fails
only under `fail-on: warning`: a warning here is something the official
validator raises and then accepts the document anyway, and turning a build red
for one by default would misrepresent the authority.

## Annotations and the job summary

Findings appear three ways, and you can turn any of them off:

**On the pull request** — one annotation per file, on the line of its first
finding, with the count and the other findings listed:

```
Error: BR-DE-15 (BT-10) and 2 more: 3 errors — invoices/2026-000142.xml, line 2
XRechnung requires a buyer reference (BT-10). For German public-sector buyers this is the
Leitweg-ID; business buyers may supply any reference, but the field must be present.
Fix: Ask your client for their Leitweg-ID (public sector) or an order/customer reference,
and set buyerReference. At: /ubl:Invoice/cbc:BuyerReference (nearest element in the
file: <ubl:Invoice>, line 2)
Also in this file:
- BR-CL-14 (BT-40), line 24: The seller country code (BT-40) must be an ISO 3166-1 alpha-2 code, but "XX" is not in the list.
- BR-CL-14 (BT-55), line 61: The buyer country code (BT-55) must be an ISO 3166-1 alpha-2 code, but "XX" is not in the list.
The job summary lists every finding with its fix.
```

The line is the one the rule engine read off your file: the element the finding
is about, or, when that element is missing, the element it belongs in, and the
message says which. Paths are in the file's own syntax, so a CII invoice gets
CII paths. A Factur-X PDF's findings are on lines of the XML inside it, so its
annotation names `line 117 of factur-x.xml` and puts no mark on the PDF.

GitHub shows ten annotations of each kind per step. When more files than that
have findings, nine get an error annotation, the step's failure message (the
tenth) says how many more there are, and those are listed in the log; the job
summary always has every finding.

**In the job summary** — one block per document, with every rule ID linked to
its page on [attestwire.com/rules](https://attestwire.com/rules):

> ## Validate E-Invoice (EN 16931) — FAIL
>
> **12** documents · **1** error · **0** warnings · **3** informational
>
> Mode: **local** · Rules: bundled `@attestwire/en16931@0.12.1` — pinned, offline, no key · Fails on: `error`
>
> ### FAIL — `invoices/2026-000142.xml`
> UBL · xrechnung-ubl
>
> | Severity | Rule | Term | What the regulation requires | Fix |
> | --- | --- | --- | --- | --- |
> | error | [BR-DE-15](https://attestwire.com/rules/BR-DE-15) | BT-10 | XRechnung requires a buyer reference (BT-10). … | Ask your client for their Leitweg-ID … |

**On the Security tab** — set `sarif` and upload it. The job needs
`permissions: security-events: write`:

```yaml
- uses: attestwire/validate-einvoice-action@v1
  id: invoices
  with:
    files: "invoices/**/*.xml"
    sarif: einvoice.sarif
- uses: github/codeql-action/upload-sarif@v4
  if: always()
  with:
    sarif_file: einvoice.sarif
    category: einvoice
```

The report is **one SARIF run covering every document** the action examined:
code scanning refuses a file with two runs of the same tool and category, and
takes at most 20 runs per file. Each finding points at its file and, in XML, at
its line; documents with no findings are listed too, so the report records what
was checked. The report sets no category of its own, so the upload's
`category` applies. Give each upload in a workflow its own category.

## Why rule-set stability matters in CI

This is the number one thing integrators ask for, so it is the default.

E-invoicing rule sets move. XRechnung ships a new configuration roughly twice a
year, Peppol BIS Billing three times, and each release adds rules that make
previously-accepted documents invalid. A validator that always fetches the
current rule set is doing you a favour right up until the morning it turns forty
green builds red on a commit that changed nothing — and you cannot tell whether
your invoice broke or the rules moved.

So this action ships the engine **pinned**:

- **Local mode (default)** — `@attestwire/en16931@0.12.1` is bundled into
  `dist/index.js`. A given tag of this action always runs exactly those rules.
  Same commit, same verdict, on any runner, offline, forever. You upgrade rules
  the way you upgrade any dependency: by bumping the action's tag, in a pull
  request, where the diff in findings is visible before it is enforced.
- **api mode (`api-key` set)** — every document goes to the hosted validator,
  which always runs the **current** rule set and returns a `provenance` block
  naming the engine version and rule set that judged it. Your build tracks the
  regulation, and when it goes red you can see from the summary which rule set
  said so. The file is sent as it is on disk, a PDF whole as
  `application/pdf`, and read there by the same engine call local mode makes.

| | local (default) | api (`api-key` set) |
| --- | --- | --- |
| Rule set | pinned to the action tag | always current |
| Reproducible | yes — byte-identical verdicts | no, by design |
| Network / secrets | none | HTTPS + a key |
| Rate limits | none | your plan's quota |
| Provenance in the response | the pinned version | engine version + rule set that ran |
| Validation Records | — | `record: true` |
| Cost | free | metered |

Neither is the right answer for everyone. Pin for a release pipeline that must
be reproducible; track for a nightly job whose purpose is to find out that the
rules moved. Plenty of teams run both — pinned on pull requests, hosted on a
schedule:

```yaml
on:
  pull_request:
  schedule: [{ cron: "0 6 * * 1" }]
jobs:
  invoices:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: attestwire/validate-einvoice-action@v1
        with:
          files: "invoices/**/*.xml"
          # On the weekly run only, judge against the current rule set.
          api-key: ${{ github.event_name == 'schedule' && secrets.ATTESTWIRE_API_KEY || '' }}
```

What is running is published at
[attestwire.com/rule-currency](https://attestwire.com/rule-currency), with a
machine-readable feed at `/rule-currency.json`.

## Validation Records

In api mode, `record: true` mints a **Validation Record** per document: a
fingerprint of the file (its bytes, the PDF itself for a Factur-X), the
verdict, the rule set and the date, at a URL
somebody outside your CI can open. Useful when a counterparty disputes a
rejection, or when an auditor wants evidence that a document was checked at the
time it was sent. The URLs land in the `record-urls` output and in the job
summary.

```yaml
- uses: attestwire/validate-einvoice-action@v1
  with:
    files: "invoices/**/*.xml"
    api-key: ${{ secrets.ATTESTWIRE_API_KEY }}
    record: true
```

A record is only meaningful because a third party minted it — which is why
`record: true` without `api-key` is refused rather than quietly ignored.

## What this does not do

Stated plainly, because you will find out eventually and it is better to find
out now:

- **It is a pre-flight, not the authority.** Documents are read into the
  EN 16931 invoice model and the rules run against that model. Rules that
  constrain the XML itself rather than the model — BR-01, and BR-DE-13 /
  BR-DE-21 on BT-24 — do not run, so a document that passes here can still be
  rejected by KoSIT or by a receiving platform. The engine's verdicts are
  checked against KoSIT's own validator (1.6.3, configuration 3.0.2) by hand at
  recorded dates, not on every call.
- **A Factur-X PDF's container is not validated.** The embedded CII XML is
  extracted and judged; PDF/A-3 conformance, attachment relationships and XMP
  metadata are not checked. A valid payload does not make a valid Factur-X file.
- **No FatturaPA, no country formats outside EN 16931's syntaxes.**
- **`profile` is local mode only.** In api mode the hosted validator judges each
  document against the profile it declares.

## Examples

Complete workflows are in [`examples/`](examples/):

- [`validate-invoices.yml`](examples/validate-invoices.yml) — the standard
  pull-request check, with SARIF upload.
- [`weekly-rule-currency.yml`](examples/weekly-rule-currency.yml) — pinned on
  PRs, hosted on a schedule, so a rule-set change is a Monday-morning issue
  rather than a Friday-afternoon rejection.

## Related

- [`@attestwire/en16931`](https://github.com/attestwire/en16931): the rule
  engine this action bundles, for validating and generating invoices in your
  own code. MIT, no network calls.
- [`medusa-plugin-einvoice`](https://github.com/attestwire/medusa-plugin-einvoice):
  XRechnung and Factur-X from Medusa v2 orders, on the same engine.
- [Rule reference](https://attestwire.com/rules/): one page per rule, with the
  reason and the fix. Every finding in the job summary links to its page.

## Licence

MIT. The bundled rule engine, [`@attestwire/en16931`](https://www.npmjs.com/package/@attestwire/en16931),
is MIT too — it needs no account and no key, and nothing it does makes a network
call. Use it directly if you want validation outside CI.

The code is what the licence covers. "Attestwire"™ and the Attestwire logo are
trademarks of this project's owner, and no trademark right comes with MIT. Say
your action or product uses this one, or is built on it — that is accurate and
fine. Do not name or brand a product or service "Attestwire", and do not word it
so a reader would think we endorse yours.
