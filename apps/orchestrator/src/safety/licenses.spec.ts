import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, verifyLicense, type MigrationManifest } from "@mh/shared";
import { Store } from "../store.js";
import { LicenseService } from "./licenses.js";

const MID = "MH-0001";

function manifest(rustTree = [{ path: "src/main.rs", sha256: "b".repeat(64) }]): MigrationManifest {
  return buildManifest({
    migrationId: MID,
    sourceRepo: "acme/legacy",
    sourceCommit: "abc1234",
    targetRepo: "acme/legacy",
    targetBranch: "mh/MH-0001",
    files: { created: 1, modified: 0, deleted: 0 },
    validation: { dotnetTests: "34/34", rustTests: "34/34", parity: "384/384", clippy: "PASS", security: "PASS" },
    rustTree,
    frozenAt: "2026-08-28T12:00:00.000Z",
  });
}

let store: Store;
let svc: LicenseService;

beforeEach(() => {
  store = new Store(":memory:");
  store.createMigration({
    id: MID,
    sourceRepo: "acme/legacy",
    sourceCommit: "abc1234",
    sourcePath: "src/Api",
    targetRepo: "acme/legacy",
    targetBranch: "mh/MH-0001",
    at: "t0",
  });
  svc = new LicenseService(store);
});
afterEach(() => store.close());

const mintArgs = (m: MigrationManifest) => ({
  migrationId: MID,
  manifest: m,
  decidedBy: "yash@example.com",
  permittedAction: "open PR on acme/legacy",
  target: "acme/legacy:mh/MH-0001",
  at: "t1",
});

describe("LicenseService", () => {
  it("mints a single-use nonce bound to the manifest digest", () => {
    const m = manifest();
    const lic = svc.mint(mintArgs(m));
    expect(lic).toMatchObject({
      licenseId: "LIC-MH-0001-01",
      decision: "allow",
      uses: 1,
      consumedAt: null,
      approvedManifestSha256: m.manifestSha256,
    });
    expect(verifyLicense(lic, m).ok).toBe(true);
  });

  it("increments the license sequence per migration", () => {
    svc.recordDenial(MID, "yash@example.com", "not yet", "t1");
    const lic = svc.mint(mintArgs(manifest()));
    expect(lic.licenseId).toBe("LIC-MH-0001-02");
  });

  it("consume spends the only use — a second consume-check fails", () => {
    const m = manifest();
    const lic = svc.mint(mintArgs(m));
    svc.consume(lic.licenseId, "t2");

    const after = store.getLicenseById(lic.licenseId)!;
    expect(after.uses).toBe(0);
    expect(after.consumedAt).toBe("t2");
    expect(verifyLicense(after, m).ok).toBe(false);
    expect(svc.check(MID, m).ok).toBe(false);
  });

  it("invalidate voids an un-consumed license with a reason", () => {
    const m = manifest();
    const lic = svc.mint(mintArgs(m));
    svc.invalidate(lic.licenseId, "t2", "workspace edited after approval");

    const after = store.getLicenseById(lic.licenseId)!;
    expect(after.invalidatedAt).toBe("t2");
    expect(after.invalidationReason).toMatch(/workspace edited/);
    expect(svc.check(MID, m).ok).toBe(false);
  });

  it("check fails when the manifest digest no longer matches the license", () => {
    svc.mint(mintArgs(manifest()));
    // a different manifest (extra file) → different digest
    const other = manifest([
      { path: "src/main.rs", sha256: "b".repeat(64) },
      { path: "src/pricing.rs", sha256: "c".repeat(64) },
    ]);
    expect(svc.check(MID, other).ok).toBe(false);
  });
});
