/**
 * The GitHub-write allowlist — the hard RED boundary.
 *
 * `mh-cutover` is the only agent in the pipeline granted any GitHub write tool,
 * and it is granted *only* these four. Every one is `approval: required` in the
 * agent config, and every approval is routed through `approval-router.ts`. The
 * backend never trusts TrueForge's own destructive-tool detection (issue #318:
 * it can fail open on an unannotated MCP tool), so this list is the authority.
 */
export const CUTOVER_WRITE_ALLOWLIST: readonly string[] = [
  "create_branch",
  "create_or_update_file",
  "push_files",
  "create_pull_request",
  "merge_pull_request",
];

/** Names that always denote a write, matched loosely so `github.create_branch` etc. still hit. */
const WRITE_VERBS = /(create|update|push|merge|delete|add|remove|write|commit|force)/i;

export function isWriteToolAllowed(toolName: string): boolean {
  if (!toolName) return false;
  const base = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  return CUTOVER_WRITE_ALLOWLIST.includes(base);
}

/** A tool that writes but is NOT on the allowlist — always denied, no license can widen it. */
export function isUnlistedWrite(toolName: string): boolean {
  const base = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  return WRITE_VERBS.test(base) && !CUTOVER_WRITE_ALLOWLIST.includes(base);
}
