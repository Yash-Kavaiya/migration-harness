# Safety model

MigrationHarness generates code and then proves things about it. Generated code
does **not** earn authority by compiling, passing tests, or even matching golden
behavior. The only thing that authorizes a write to the canonical repository is a
human licensing one specific, hashed, verified migration manifest.

> **Implementation status.** The primitives — the nine gates, `canCutover`,
> `verifyLicense`, `verifyCutoverPreconditions`, `consumeLicense`,
> `invalidateLicense` — live in `@mh/shared` and are tested (`tests/`). The seven
> scoped agents and their MCP restrictions land in PR #2; the orchestrator that
> *calls* these primitives at the right moments (recompute gates before cutover,
> re-verify TOCTOU, invalidate + clear on mismatch, persist consumption after the
> PR) is wired across PRs #5 and #9. Where this doc says "the orchestrator
> refuses / consumes / invalidates", read it as the designed control that those
> PRs implement — not yet a property of `main`.

## Action classes

| Class | Actions | Control |
|---|---|---|
| **GREEN** — automatic | read the source repo, analyze it, generate Rust, write sandbox files, compile, run tests, replay fixtures | none |
| **AMBER** — automatic, audited | overwrite/delete generated sandbox files, regenerate fixtures, apply repair patches | every attempt logged to `repair-log.json` and the event store |
| **RED** — human license required | create a branch, push, open a PR, merge, modify the canonical repo in any way | see below — five independent layers |

## The five layers on RED

1. **Generated code runs only in Daytona.** It never executes on the orchestrator
   host or anywhere with credentials.
2. **The agents that touch generated code have zero GitHub tools.**
   `mh-migrator`, `mh-parity`, `mh-repair`, and `mh-security` have *no MCP servers
   at all* (`tests/agents.spec.ts` pins the exact scope of every agent). Generated
   Rust physically cannot reach a repo through the harness.
3. **Only `mh-cutover` can write to GitHub, and every write pauses for approval.**
   Its manifest sets `requireApprovalForTools: ["@all"]` — each branch creation,
   file write, and PR open shows up in the UI for a human to allow or deny before
   it executes.
4. **The orchestrator refuses to invoke cutover** unless `canCutover(gates)` is
   true — every one of the nine gates green, which includes a valid unconsumed
   license (gate 9) whose `approvedManifestSha256` still equals
   `sha256Manifest(currentManifest)`. (`canCutover` + `verifyLicense` are in
   `@mh/shared`; PR #9 makes the cutover stage call them and refuses otherwise.)
5. **The license is single-use and hash-bound.** It authorizes exactly one
   manifest digest and exactly one target (`manifest.targetRepo` /
   `manifest.targetBranch`). `consumeLicense` sets `uses: 0` and stamps
   `consumedAt` after the PR is created; `verifyLicense` then rejects any later
   attempt. PR #9 persists that consumption transactionally with PR creation.

## The manifest and the license

Once gates 1–8 pass, the orchestrator builds a `migration-manifest.json`: source
commit, target repo/branch, file counts, every validation number, and
`rustTreeSha256` — an order-independent hash of every generated file's contents.
It then computes `manifestSha256` over the whole manifest (with the digest field
itself omitted) and freezes it read-only.

The human sees the manifest and clicks **LICENSE MIGRATION** or **DENY**. On
allow, a `license.json` is written binding `approvedManifestSha256` to that exact
digest, with `uses: 1`.

## TOCTOU

Between "human clicks license" and "cutover agent makes the first GitHub write",
the generated tree could change (a stray repair, a regeneration, tampering).
Immediately before the first write, `verifyCutoverPreconditions` re-hashes the
Rust tree **as it exists now** and compares it to `manifest.rustTreeSha256`
(`@mh/shared`; `tests/manifest-toctou.spec.ts`). On mismatch it returns
`ok: false`; the cutover stage (PR #9) then calls `invalidateLicense` +
`clearLicense`, blocks the stage, and the UI shows "migration changed after
authorization — re-approval required".

## The target is not a free parameter

A license authorizes writes to the target *in the manifest*. `mh-cutover`'s
prompt takes `targetRepo` / `targetBranch` from `manifest.*` only and stops if a
turn-message value disagrees. PR #9 adds the belt-and-braces orchestrator-side
check (compare the manifest target to the request target, and to
`license.target`, before invoking the stage).

## What this model does NOT claim

- **Sandbox egress.** Disabling outbound network from the Daytona sandbox is an
  infrastructure control, not something the harness or a prompt enforces. The
  "generated code can't exfiltrate the source" property holds only when
  `mh-migrator` runs on a pre-baked snapshot with the toolchain vendored and
  egress off. When it falls back to a network toolchain install it records
  `egressIsolated: false` and says so.
- **Security proof.** `mh-security` runs five parity checks and emits a report. It
  is not a penetration test or a formal audit, and the report says so.
- **Semantic completeness.** Parity only verifies behavior that a fixture
  exercises. The contract stage is responsible for a fixture matrix broad enough
  that "100% parity" means something.
