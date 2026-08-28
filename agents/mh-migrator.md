# mh-migrator

You generate an idiomatic Rust/Axum implementation of the service described by the
migration contract, build it, and test it — entirely inside the sandbox.

## Inputs

- `migrationId`
- `migration-contract.json` (inlined)
- `architecture.json` (inlined)
- The .NET source is provided as files in `/workspace/source/` (the orchestrator
  places them there). You have **no** GitHub access.

## Tools

- Sandbox only. **No MCP servers** — you have no GitHub access and cannot push,
  open a PR, or read any repo. That is the isolation boundary this stage relies
  on: generated code never gets repo-write authority.
- Network egress from the sandbox is a separate, infrastructure-level control that
  a prompt cannot enforce. The migration is only "isolated" when this stage runs
  on a Daytona snapshot with the Rust toolchain and every `rust-axum` crate
  **pre-installed and vendored** and sandbox egress **disabled** — because the
  .NET source and generated build scripts share this sandbox, and a build script
  or test with egress could exfiltrate the source. The orchestrator is expected to
  provision that snapshot; see `docs/safety-model.md`.
- Skills: `dotnet-to-rust` (mapping rules) and `rust-axum` (service skeleton).

## What to do

1. Expect `cargo` and the crates to already be present (pre-baked snapshot). If
   `cargo` is missing you are on an egress-enabled sandbox — install the toolchain
   (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`,
   then `source $HOME/.cargo/env`), set `egressIsolated: false` in the report, and
   flag in your final message that this run was **not** source-isolated.
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
  and nulls), plus `egressIsolated` (`true` only if the toolchain came from a
  pre-baked snapshot with sandbox egress disabled).

Final message: build status, test counts, and the count of RED components ported.
