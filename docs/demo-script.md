# Demo script (~3 minutes)

Goal: show a real agent reaching real tools, executing generated code safely, and
**pausing before an irreversible action** until a human licenses it.

## Setup (before recording)

- TrueForge running at `localhost:8790` with: Anthropic model, `github-read` +
  `github-write` MCP servers (different tokens), Daytona sandbox provider, 5 skills
  registered at a pinned tag.
- `npm run sync-agents` has applied all 7 agents.
- Orchestrator (`:8080`) and web UI (`:3000`) running.
- `orderpricing-legacy` public repo exists with committed `fixtures/`.
- A throwaway state: no in-progress migration.
- Nothing secret on screen — no Daytona key, no PAT, no model key.

## Beats

**0:00 — The pitch (spoken over Screen 1).**
"Compilation proves Rust syntax. This proves behavior. It migrates a .NET service
to Rust and refuses to touch the real repo until a human licenses the exact
verified change."

**0:15 — Start.** Screen 1: pick `orderpricing-legacy`, path `src/OrderPricing.Api`,
target Rust/Axum. Click **Start migration** → redirect to Screen 2.

**0:25 — Discovery + contract.** PipelineRail lights up `discover` → `contract`.
AgentTimeline shows `mh-architect` making a **real `github-read` MCP call**, then
writing `architecture.json`. Point at the AuthorityPanel footer:
`Repo Read ✓ · Sandbox ✓ · Workspace Write ✓ · GitHub Push 🔒 · Merge 🔒`.

**0:50 — Generate + build in the sandbox.** `mh-migrator` writes Rust under
`/workspace/rust-service`, runs `cargo build` + `cargo test` — all inside Daytona.
"Generated code runs isolated. This agent has no GitHub tools at all."

**1:15 — Parity finds the bug.** `mh-parity` replays the committed goldens.
Parity panel jumps to something like **271 / 296**. Open the Parity Inspector on
one mismatch: .NET `170.00`, Rust `169.99`, hypothesis "monetary rounding:
banker's rounding not preserved". "The Rust compiles and its own tests pass. It's
still wrong."

**1:40 — Repair.** `mh-repair` diagnoses `decimal` → `f64`, switches the money
path to `rust_decimal` with banker's rounding, re-runs parity → **296 / 296**.

**2:00 — Gates + freeze.** GateGrid goes all green. The orchestrator freezes the
manifest and shows `Manifest SHA256: …`. The License card unlocks.

**2:10 — Reconnect.** Refresh the browser mid-run once (earlier is fine). The UI
catches up from the event store and re-attaches — nothing is lost.

**2:20 — The pause.** Screen 4: source → target, gate grid all PASS, file counts,
target branch, the SHA. "Everything is proven. Nothing has been written. This is
the stop." Click **LICENSE MIGRATION**.

**2:35 — Cutover with a checkpoint.** `mh-cutover` starts. A **tool-approval
prompt** appears in the UI *before* the branch is created — approve it on camera.
It opens a **real PR** on `orderpricing-legacy`.

**2:50 — Done.** Screen 5: the real PR link, `License consumed ✓`, the audit
timeline. "One human decision, bound to one hash, spent once."

## Safety beats to film separately (B-roll)

- Try to license with parity red → the button is disabled.
- Approve, then edit a Rust file in the sandbox → cutover shows "migration changed
  after authorization — re-approval required".
- Second cutover attempt after consumption → rejected.

## Don't forget

- Show at least one **merged Qodo-reviewed PR** and the README evidence section.
- Keep it under 3 minutes. Record 3 takes.
