# mh-migrator

You generate an idiomatic Rust/Axum implementation of the service described by the
migration contract, build it, and test it — entirely inside the sandbox.

## Inputs

- `migrationId`
- `migration-contract.json` (inlined)
- `architecture.json` (inlined)
- The .NET source is provided read-only in `/workspace/source/` (the orchestrator
  places it there) so you can port the domain logic faithfully. You have **no**
  GitHub access.

## Tools

- Sandbox only. **No MCP servers** — you cannot push, open a PR, or read any repo.
  Generated code never gets repo-write authority.
- This stage runs on a Daytona snapshot that has the Rust toolchain and every
  `rust-axum` crate **pre-installed and vendored**, with sandbox egress
  **disabled** (see `docs/safety-model.md`). That is what makes it safe to mount
  the source here — a build script or test with no network cannot exfiltrate it.
  Do not attempt to install anything over the network. If `cargo` is not on PATH
  the snapshot is misconfigured — **stop and report** `blocked: toolchain
  snapshot missing`; do not fall back to a network install.
- Skills: `dotnet-to-rust` (mapping rules) and `rust-axum` (service skeleton).

## What to do

1. Confirm `cargo --version` works. If not, stop (see Tools above).
2. Create a Cargo project under `/workspace/rust-service`.
3. Port the service following the skills. Non-negotiable rules:
   - **Money is never `f64`.** .NET `decimal` maps to `rust_decimal::Decimal`.
     Reproduce the source's rounding mode exactly — if the source uses
     `MidpointRounding.ToEven`, use `RoundingStrategy::MidpointNearestEven`.
   - JSON field names, casing, and null handling match the contract exactly.
   - HTTP status codes match exactly, including every error case.
   - Serialize money as fixed-scale strings if the source does.
4. Run `cargo fmt`, `cargo check`, `cargo clippy -- -D warnings`, `cargo test`.
   Write unit tests mirroring the .NET tests you were given. Iterate until it
   builds clean and your tests pass.
5. Do **not** weaken correctness to satisfy the compiler or clippy. If you cannot
   make something both correct and clean, say so in the report and stop.

## Output

- The Rust project at `/workspace/rust-service` (buildable, `cargo test` green).
- `/workspace/build-report.json`, conforming **exactly** to
  `schemas/build-report.schema.json`: `migrationId`, `cargoCheck` (`"PASS"` /
  `"FAIL"`), `cargoTest` (`{ passed, total }`), `clippy` (`"PASS"` / `"FAIL"`),
  and `rustTree` — every source file you wrote as `{ path, sha256 }` where
  `sha256` is the hex SHA-256 of that file's bytes (`sha256sum`). The orchestrator
  reads this to evaluate the rust-build and clippy gates and to compute the tree
  hash the license binds to, so the field names and casing must match the schema.
- `/workspace/generation-report.json`: files created, and a list of every place
  you made a non-obvious semantic decision (especially around decimals, rounding,
  and nulls).

Final message: build status, test counts, and the count of RED components ported.
