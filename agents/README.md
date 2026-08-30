# agents/

The seven scoped TrueForge agents that run the migration pipeline. These files are
the **source of truth**; `npm run sync-agents` applies them to the TrueForge server.

Each agent is two files:

| File | Contents |
|---|---|
| `mh-<name>.md` | The instructions (system prompt). Human-readable, reviewed here. |
| `mh-<name>.json` | `{ name, instructionsFile, manifest }` — model, MCP scope, skills, runtime config. `instructions` is injected from the `.md` at sync time. |

## Why seven saved agents instead of subagents

TrueForge subagents are dynamic and inherit the root agent's tool scope — there is
no per-subagent least privilege. So each pipeline stage is its own **saved agent**
with exactly the access it needs, and a thin orchestrator sequences their sessions.

## The scope table (the safety backbone)

| Agent | GitHub | Sandbox | Skills | Approval | Produces |
|---|---|---|---|---|---|
| `mh-architect` | `github-read` · read-only | ✓ | dotnet-analysis | — | `architecture.json` |
| `mh-contract` | `github-read` · read-only | ✓ | behavioral-parity | — | `migration-contract.json`, `fixture-plan.json` |
| `mh-migrator` | **none** | ✓ | dotnet-to-rust, rust-axum | — | Rust project + `generation-report.json` |
| `mh-parity` | **none** | ✓ | behavioral-parity | — | `parity-report.json` |
| `mh-repair` | **none** | ✓ | dotnet-to-rust, rust-axum | — | patched Rust + `repair-log.json` |
| `mh-security` | **none** | ✓ | secure-migration | — | `security-report.json` |
| `mh-cutover` | `github-write` · **all tools** | — | — | **every tool** | branch + PR |

`mh-migrator`, `mh-parity`, and `mh-repair` have **no MCP servers at all** —
generated code physically cannot push to a repo or reach the network. `mh-cutover`
is the only agent that can write to GitHub, and every one of its writes pauses for
human approval in the UI.

`github-read` and `github-write` are two separate MCP server entries in the
TrueForge UI backed by **different tokens** — the write token is a fine-grained PAT
scoped to the canonical repo only.

## Syncing

```bash
npm run sync-agents -- --dry-run   # show what would change
npm run sync-agents                # create/update on the server
npm run sync-agents -- --check     # exit non-zero if the server has drifted
```

Requires `TRUEFORGE_BASE_URL` (and `TRUEFORGE_API_KEY` if the server has auth on)
in `.env`. The MCP servers (`github-read`, `github-write`) and skills must already
exist in the TrueForge UI — `--check` will tell you if a referenced name is missing.
