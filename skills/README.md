# skills/

Git-backed instruction packs the agents load on demand. TrueForge materializes each
`skills/<name>/` directory at `/opt/tfy/skills/<name>` inside the sandbox when an
agent that references it runs.

| Skill | Loaded by | Purpose |
|---|---|---|
| `dotnet-analysis` | mh-architect | Enumerate a .csproj service → `architecture.json`; classify component risk; detect out-of-scope features. |
| `dotnet-to-rust` | mh-migrator, mh-repair | C# → Rust type and idiom mapping, with the money/rounding/nullability traps called out. |
| `rust-axum` | mh-migrator, mh-repair | Idiomatic Axum + Tokio service skeleton, error→status mapping, serde field fidelity. |
| `behavioral-parity` | mh-contract, mh-parity | The fixture coverage matrix and the response-normalization rules. |
| `secure-migration` | mh-security | The five security-parity checks. |

## Format

Each skill is a directory with a `SKILL.md`:

```
---
name: <kebab-case, matches the directory name and the agent reference>
description: <one line — when the agent should reach for this skill>
---

<markdown body>
```

Optional `references/` and `scripts/` subdirectories are materialized alongside.

## Registering with TrueForge

In the TrueForge UI: **Settings → Skills → Add**, pointing at
`https://github.com/Yash-Kavaiya/migration-harness`, path `skills/`, ref = a pinned
tag. `npm run sync-agents -- --check` warns if an agent references a skill the
server does not have.
