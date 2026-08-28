import { describe, expect, it } from "vitest";
import { buildManifest, consumeLicense, type MigrationLicense, type MigrationManifest } from "@mh/shared";
import { routeApproval } from "./approval-router.js";

const TREE = [
  { path: "Cargo.toml", sha256: "a".repeat(64) },
  { path: "src/main.rs", sha256: "b".repeat(64) },
];

const manifest: MigrationManifest = buildManifest({
  migrationId: "MH-0001",
  sourceRepo: "acme/legacy",
  sourceCommit: "abc1234",
  targetRepo: "acme/legacy",
  targetBranch: "mh/MH-0001",
  files: { created: 2, modified: 0, deleted: 0 },
  validation: { dotnetTests: "34/34", rustTests: "34/34", parity: "384/384", clippy: "PASS", security: "PASS" },
  rustTree: TREE,
  frozenAt: "2026-08-28T12:00:00.000Z",
});

const liveLicense: MigrationLicense = {
  licenseId: "LIC-MH-0001-01",
  migrationId: "MH-0001",
  decision: "allow",
  approvedManifestSha256: manifest.manifestSha256,
  permittedAction: "open PR on acme/legacy",
  target: "acme/legacy:mh/MH-0001",
  uses: 1,
  consumedAt: null,
  invalidatedAt: null,
  decidedBy: "yash@example.com",
  decidedAt: "2026-08-28T12:05:00.000Z",
};

const req = (name: string) => ({ toolCalls: [{ id: "tc-1", name }] });

describe("routeApproval", () => {
  it("allows an allowlisted write when the license and tree are intact", () => {
    const d = routeApproval(req("create_pull_request"), { license: liveLicense, manifest, currentRustTree: TREE });
    expect(d).toEqual({ action: "allow", toolCallId: "tc-1", toolName: "create_pull_request" });
  });

  it("denies a write tool that is not on the allowlist — no license can widen it", () => {
    const d = routeApproval(req("delete_repository"), { license: liveLicense, manifest, currentRustTree: TREE });
    expect(d.action).toBe("deny");
  });

  it("parks when there is no license", () => {
    const d = routeApproval(req("create_pull_request"), { license: null, manifest, currentRustTree: TREE });
    expect(d.action).toBe("park");
  });

  it("parks when the license was already consumed (single-use)", () => {
    const spent = consumeLicense(liveLicense, "t2");
    const d = routeApproval(req("push_files"), { license: spent, manifest, currentRustTree: TREE });
    expect(d.action).toBe("park");
  });

  it("parks with a TOCTOU reason when the Rust tree drifted after approval", () => {
    const drifted = [...TREE, { path: "src/sneaky.rs", sha256: "d".repeat(64) }];
    const d = routeApproval(req("create_or_update_file"), { license: liveLicense, manifest, currentRustTree: drifted });
    expect(d.action).toBe("park");
    if (d.action === "park") expect(d.reason).toMatch(/TOCTOU|changed/i);
  });

  it("parks when the approval event carries no tool call id", () => {
    const d = routeApproval({ toolCalls: [] }, { license: liveLicense, manifest, currentRustTree: TREE });
    expect(d.action).toBe("park");
  });
});
