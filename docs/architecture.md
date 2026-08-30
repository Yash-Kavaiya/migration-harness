# Architecture

> Describes the whole system: `@mh/shared`, seven scoped agents, five skills,
> the Fastify orchestrator, DemoGateway, and the Next.js control-center UI.

## The split

**TrueForge owns** the agent loop, the Daytona sandbox, MCP connections, tool
approvals, sessions/turns, the SSE event stream, and dynamic subagents.

**The orchestrator owns** only: the migration state machine, the nine quality
gates, the manifest, the license, and the sequencing of agent sessions. It is a
thin control plane — roughly one Fastify service plus a SQLite file.

**`@mh/shared` owns** the pure contract: the zod types, the gate logic, the
manifest hashing + license verification, and the state machine. The orchestrator,
the UI, and the safety test suite all import the same code.

```
orderpricing-legacy (canonical repo)          migration-harness (this repo)
  .NET 8 API + xUnit                             apps/web       Next.js control center
  openapi.json                                        │ REST + SSE
  fixtures/fixtures.json  (committed goldens)     apps/orchestrator  Fastify + node:sqlite
        │ GitHub MCP (read)                            │  state machine · gates · manifest · license
        │ GitHub MCP (write, approval-gated)           │ @truefoundry/trueforge-sdk
        ▼                                              ▼
  ╔══════════════ TrueForge (localhost:8790) ══════════════╗
  ║  7 saved agents (scoped MCP + approval)                ║
  ║  Daytona sandbox   ·   5 skills   ·   sessions/turns   ║
  ╚═══════════════════════════════════════════════════════╝
```

## Stage pipeline

Each non-human stage is one TrueForge session. The orchestrator sequences them and
persists every artifact and event.

```
discover ─▶ contract ─▶ migrate ─▶ parity ─▶ security ─▶ freeze ─▶ license ─▶ cutover ─▶ complete
   │            │           │  ▲        │                  (gates)   (human)   (mh-cutover)
mh-architect mh-contract mh-migrator │  mh-parity        orchestrator
                              └── repair ──┘
                              mh-repair (bounded: 3 rounds)
```

| Stage | Agent | Produces | Feeds gate |
|---|---|---|---|
| discover | `mh-architect` | `architecture.json` | 1 |
| contract | `mh-contract` | `migration-contract.json`, `fixture-plan.json` | 2, 4 |
| migrate | `mh-migrator` | Rust project, `build-report.json` | 3, 7 |
| parity | `mh-parity` | `parity-report.json` | 5, 6 |
| repair | `mh-repair` | patched Rust, `repair-log.json` | (re-runs parity) |
| security | `mh-security` | `security-report.json` | 8 |
| freeze | orchestrator | `migration-manifest.json` + `manifestSha256` | — |
| license | human | `license.json` | 9 |
| cutover | `mh-cutover` | branch + PR on the canonical repo | — |

## The nine gates

`@mh/shared/gates.ts`. `readyToFreeze` = gates 1–8 green. `canCutover` = all 9.

1. **discovery** — `architecture.json` valid, `unsupported[]` empty
2. **contract** — ≥1 endpoint contract
3. **rust-build** — `cargo check` PASS and every test passes
4. **source-tests-preserved** — `representedAsFixtures >= discovered` xUnit cases
   (an aggregate check; the contract stage is responsible for a per-test mapping,
   not just the count)
5. **behavioral-parity** — 100% (`passed === total`, `failed === 0`)
6. **api-compatibility** — parity clean, every contract route exercised
7. **clippy** — `cargo clippy -- -D warnings` clean
8. **security** — all five checks present and `pass`, zero new high-severity
9. **human-license** — a valid, unconsumed, hash-matched license exists

## Differential parity (golden-file)

The .NET service never runs in the sandbox. `orderpricing-legacy` ships a
committed `fixtures/fixtures.json` — request → response pairs captured from the
real .NET service by its own fixture generator. `mh-parity` starts the generated
Rust service in the sandbox, replays each request, and diffs the normalized
response against the golden.

**The trap:** `PricingEngine`/`Money.cs` rounds money with
`MidpointRounding.ToEven`. A Rust port that maps `decimal` onto `f64` agrees on
most inputs and diverges on the ~20% that land on a half-cent. `mh-parity` reports
"monetary rounding" mismatches; `mh-repair` moves the money path to
`rust_decimal::Decimal` with `RoundingStrategy::MidpointNearestEven`; re-run → 100%.

## Persistence & reconnect

SQLite (`node:sqlite`, built-in). Every TrueForge event is stored with a monotonic
per-migration sequence and also broadcast on the migration's SSE stream. A UI that
drops its connection reconnects with `?after=<seq>`; the server replays the gap
then re-attaches live. A full orchestrator restart resumes too — the stage/phase
is in the database, and `AgentGateway.resume` re-attaches to a running turn via
`subscribeToTurn` (or replays a finished one via `listTurnEvents`).

See [`safety-model.md`](safety-model.md) for the authority model and
[`qodo.md`](qodo.md) for the review process.
