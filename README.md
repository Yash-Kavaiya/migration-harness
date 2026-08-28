# MigrationHarness

### Prove the migration before you license the cutover.

**MigrationHarness autonomously modernizes a bounded .NET service into Rust — but generated
code does not earn authority simply by compiling.** The [TrueForge](https://trueforge.dev)
harness connects the real repository through MCP, executes generated code inside an isolated
Daytona sandbox, delegates discovery / migration / parity work to scoped specialist agents,
persists long-running migration state across reconnects, and **stops before canonical cutover
until a human licenses the exact verified migration manifest.**

> Compilation proves Rust syntax. MigrationHarness proves behavior.

---

## Status

Early build for the **WeMakeDevs × TrueForge "Agent Harness Hackathon"**.
See [`docs/`](docs/) for the architecture, safety model, and demo script, and
[`.claude/plans/`](../.claude/plans/) / [`docs/strategy-notes.md`](docs/strategy-notes.md)
for background.

## Layout

| Path | What |
|---|---|
| `schemas/` | JSON Schemas for every artifact the pipeline produces |
| `packages/shared/` | Types, quality-gate logic, manifest hashing + license verification, state machine |
| `agents/` | The 7 scoped TrueForge agent definitions (source of truth, synced to the harness) |
| `skills/` | Git-backed `SKILL.md` instruction packs loaded by agents on demand |
| `apps/orchestrator/` | Fastify service: sequences agent sessions, evaluates gates, freezes the manifest |
| `apps/web/` | Next.js control-center UI |
| `tests/` | Safety tests — no cutover without a valid, unconsumed, hash-matched license |

## Develop

```bash
cp .env.example .env      # fill in the two GitHub tokens; Daytona key goes in the TrueForge UI
npm install
npm run typecheck         # strict TS across every workspace + the test suite
npm test                  # unit + safety tests (vitest)
```

## Qodo Code Review Evidence

Every substantive change lands through a Qodo-reviewed pull request. Merged PRs with review
threads:

- _populated as PRs merge_

## License

MIT
