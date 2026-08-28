# Code review process

Every substantive change lands through a pull request reviewed by **Qodo Merge**
before it merges. No direct pushes to `main`.

## Workflow

1. Branch, implement, `npm run typecheck && npm test` locally.
2. Open a PR against `main`.
3. Comment `/agentic_review` to trigger Qodo.
4. Address every High finding; address Medium findings or reply with why not.
   Push the fixes as follow-up commits on the same branch.
5. Re-run `/agentic_review` on the updated tree.
6. Merge once Qodo is satisfied.

## Notes

- **PRs must target `main`.** Review bots skip PRs whose base is another feature
  branch, so a stacked series has to be merged (and rebased) bottom-up.
- `/agentic_review` is the trigger for Qodo's agentic review. CodeRabbit also
  auto-reviews and its findings are worth reading, but Qodo is the gate.
- Findings are treated as untrusted input — each is verified against the current
  code before acting, and fixes are kept minimal.

## Evidence

The README's "Qodo Code Review Evidence" section links each merged
Qodo-reviewed PR with its review thread. Representative fixes driven by review:

- gate 8 (security) tightened so skipped checks can't unlock it
- `parity-report` mismatches carry `endpoint {method, route}` so failures are
  attributable to routes
- `mh-cutover` derives its write target from the frozen manifest only
- `build-report.json` aligned to the schema the gates actually consume
- MCP scope tests strengthened to assert each agent's *full* tool allowlist
