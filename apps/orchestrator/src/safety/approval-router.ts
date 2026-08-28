/**
 * Answers `tool.approval_required` during cutover using the Migration License.
 *
 * The backend allowlist (`allowlist.ts`) is the hard boundary — `mh-cutover` is
 * the only agent granted any GitHub write tool at all, and every one is marked
 * `approval: required`. This router is what those prompts hit: a write is allowed
 * only while a valid, unconsumed, manifest-matched license exists AND the Rust
 * tree still hashes to what was frozen. Otherwise the approval is parked and the
 * UI shows `license.required`.
 *
 * This is the mitigation for TrueForge issue #318 (the Code-Mode destructive-tool
 * gate can fail open): the decision never depends on TrueForge's own annotations.
 */
import { verifyCutoverPreconditions, type MigrationLicense, type MigrationManifest } from "@mh/shared";
import { isWriteToolAllowed } from "./allowlist.js";
import type { RustTreeEntry } from "@mh/shared";

export interface ApprovalRequest {
  toolCalls: Array<{ id?: string; name?: string }>;
}

export type ApprovalDecision =
  | { action: "allow"; toolCallId: string; toolName: string }
  | { action: "deny"; toolCallId: string; toolName: string; reason: string }
  | { action: "park"; reason: string };

export interface RouteContext {
  license: MigrationLicense | null;
  manifest: MigrationManifest | null;
  currentRustTree: readonly RustTreeEntry[];
}

/**
 * Decide what to do with one approval prompt. Pure — the orchestrator turns the
 * decision into a `gateway.reply` or a parked pending interaction.
 */
export function routeApproval(req: ApprovalRequest, ctx: RouteContext): ApprovalDecision {
  const call = req.toolCalls[0];
  const toolCallId = call?.id ?? "";
  const toolName = call?.name ?? "";

  if (!toolCallId) return { action: "park", reason: "approval event carried no tool call id" };

  // A tool outside the cutover allowlist is refused outright — no license can
  // widen it.
  if (!isWriteToolAllowed(toolName)) {
    return {
      action: "deny",
      toolCallId,
      toolName,
      reason: `${toolName || "unnamed tool"} is not on the cutover write allowlist`,
    };
  }

  if (!ctx.manifest) return { action: "park", reason: "no frozen manifest" };

  const pre = verifyCutoverPreconditions(ctx.license, ctx.manifest, ctx.currentRustTree);
  if (!pre.ok) {
    // No usable license (or the tree/manifest drifted) — the human must (re)decide.
    return { action: "park", reason: pre.reason ?? "cutover preconditions not met" };
  }

  return { action: "allow", toolCallId, toolName };
}
