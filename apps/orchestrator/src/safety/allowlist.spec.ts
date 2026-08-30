import { describe, expect, it } from "vitest";
import { CUTOVER_WRITE_ALLOWLIST, isUnlistedWrite, isWriteToolAllowed } from "./allowlist.js";

describe("cutover write allowlist", () => {
  it("allows exactly the four (+merge) cutover write tools, bare or namespaced", () => {
    for (const t of CUTOVER_WRITE_ALLOWLIST) {
      expect(isWriteToolAllowed(t)).toBe(true);
      expect(isWriteToolAllowed(`github.${t}`)).toBe(true);
    }
  });

  it("rejects reads and unknown tools", () => {
    expect(isWriteToolAllowed("get_file_contents")).toBe(false);
    expect(isWriteToolAllowed("list_branches")).toBe(false);
    expect(isWriteToolAllowed("")).toBe(false);
  });

  it("flags a write-shaped tool that is not on the allowlist (the #318 case)", () => {
    expect(isUnlistedWrite("delete_repository")).toBe(true);
    expect(isUnlistedWrite("force_push")).toBe(true);
    expect(isUnlistedWrite("update_branch_protection")).toBe(true);
    expect(isUnlistedWrite("create_pull_request")).toBe(false); // allowed, not "unlisted"
    expect(isUnlistedWrite("get_file_contents")).toBe(false); // not a write at all
  });
});
