---
name: secure-migration
description: Use when checking a ported service for security parity with its source — input-validation parity, error sanitization, secret leakage, dependency audit, and sensitive logging. Produces a report, not a proof.
---

# Security parity checks

The port must not be *more* exposed than the source. This is a checklist that
produces a report; it is not a security audit. Say so in the output.

## 1. input-validation-parity

For every validation rule in the contract, confirm the port enforces it and
returns the **same status and error code**:

- required fields, type checks
- numeric bounds (non-negative, min/max, precision)
- enum / reference membership (tier, country, coupon)
- collection constraints (non-empty, size limits)
- business rules (coupon minimum, expiry)

A rule that the source enforces but the port silently accepts is a `fail`.

## 2. error-sanitization

Send malformed and error-triggering requests. The response body must **not**
contain:

- stack traces, panic messages, or `Debug` formatting of internal types
- file-system paths, crate/assembly names, or version strings
- SQL, internal identifiers, or configuration values
- the raw input echoed back in a way that enables reflected injection

Error bodies should carry only a stable message and a machine code.

## 3. secret-leakage

Grep the generated source, the build output, and sample responses/logs for:

- API keys, tokens, passwords, connection strings, private keys
- hard-coded credentials or URLs with embedded auth
- `.env` contents committed into the tree

Anything found is a `fail` and a high-severity issue.

## 4. cargo-audit

Run `cargo audit`. Report every advisory. A known-vulnerable dependency with a
fix available is a `fail`. Count unfixed high/critical advisories toward
`newHighSeverity`.

## 5. sensitive-logging

Inspect the tracing/logging setup:

- request/response bodies must not be logged at `INFO` or below
- PII fields (customer ids, emails, addresses) must not appear in logs
- log level defaults to `INFO`, not `DEBUG`/`TRACE`

## Output

`security-report.json` conforming to `schemas/security-report.schema.json`:
`checks[]` each with `name`, `status` (`pass` | `fail` | `skip`), and a short
`detail`; plus `newHighSeverity` — the count of new high-severity issues the port
introduces relative to the source (0 is the target).

End the report with one line: this is an automated parity check, not a
penetration test or a formal audit.
