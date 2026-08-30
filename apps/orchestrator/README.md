# @mh/orchestrator

The thin control plane. TrueForge owns the agent loop, the sandbox, MCP, and
approvals; this service owns only the **migration state machine**, the **quality
gates**, the **manifest**, and the **license** — and it sequences the agent
sessions that do the actual work.

## Runtime

- **Fastify** HTTP + SSE
- **`node:sqlite`** (built-in — no native module to compile) for all state
- **`@truefoundry/trueforge-sdk`** to drive sessions
- **`@mh/shared`** for the gate logic and state machine (same code the UI and the
  safety tests use)

## Layout

| File | Responsibility |
|---|---|
| `config.ts` | env → typed config (zod) |
| `store.ts` | SQLite: migrations, transitions, stage runs, events, artifacts, licenses, pending interactions |
| `sse.ts` | one live event stream per migration, fanned out to every UI |
| `trueforge.ts` | `AgentGateway` — run a stage, resume after reconnect, reply to an approval, download a sandbox artifact. Behind an interface so the core is testable without a live server. |
| `orchestrator.ts` | the glue: drives the state machine, relays events, evaluates gates, records licenses |
| `server.ts` | the REST + SSE surface |
| `testing/fake-gateway.ts` | scripted stand-in for TrueForge used by the tests |

## HTTP surface

| Method | Path | |
|---|---|---|
| `POST` | `/api/migrations` | start; body `{sourceRepo, sourceCommit, sourcePath, targetRepo?, targetBranch?}` |
| `GET` | `/api/migrations/:id` | full view: stage, phase, stage runs, 9-gate grid, authority panel, pending interactions |
| `GET` | `/api/migrations/:id/events` | SSE — replays persisted events after `?after=<seq>`, then live |
| `POST` | `/api/migrations/:id/freeze` | evaluate gates 1-8; advance to `license` if green, `blocked` if not |
| `POST` | `/api/migrations/:id/license` | `{decision:"allow", licenseId}` or `{decision:"deny", reason?}` |
| `POST` | `/api/migrations/:id/interaction/:eventId` | answer a pending tool approval / question |

## Reconnect

Events are persisted with a monotonic per-migration sequence. A UI that drops the
SSE connection reconnects with the last sequence it saw; the server replays the
gap from SQLite, then re-attaches to the live stream. A full process restart
resumes too — the stage/phase is in the database, and `AgentGateway.resume` picks
a running turn back up via `subscribeToTurn` (or replays a finished one via
`listTurnEvents`).

## What's stubbed until later PRs

`StageResolver` currently returns a happy-path outcome for every stage. The real
per-stage artifact handling — download from the sandbox, validate against the zod
schema, diagnose parity mismatches, freeze + hash the manifest, verify the license
and TOCTOU before cutover — lands in PRs 6–9.

## Run

```bash
npm run start --workspace @mh/orchestrator   # :8080, talks to TRUEFORGE_BASE_URL
npm test --workspace @mh/orchestrator
```
