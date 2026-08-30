import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Manifest, type MigrationManifest } from "@mh/shared";
import { Store } from "../store.js";
import { freezeManifest, reverifyManifest } from "./manifest-service.js";

const MID = "MH-0001";

let store: Store;

function seed(over: { rustTree?: Array<{ path: string; sha256: string }> } = {}): void {
  store.createMigration({
    id: MID,
    sourceRepo: "acme/orderpricing",
    sourceCommit: "abc1234",
    sourcePath: "src/Api",
    targetRepo: "acme/orderpricing",
    targetBranch: "mh/MH-0001",
    at: "t0",
  });
  store.putArtifact(
    MID,
    "build",
    {
      migrationId: MID,
      cargoCheck: "PASS",
      cargoTest: { passed: 34, total: 34 },
      clippy: "PASS",
      rustTree: over.rustTree ?? [
        { path: "Cargo.toml", sha256: "a".repeat(64) },
        { path: "src/main.rs", sha256: "b".repeat(64) },
      ],
    },
    "t1",
  );
  store.putArtifact(
    MID,
    "parity",
    { migrationId: MID, total: 384, passed: 384, failed: 0, byRoute: [], mismatches: [] },
    "t1",
  );
  store.putArtifact(
    MID,
    "security",
    {
      migrationId: MID,
      checks: [
        { name: "input-validation-parity", status: "pass" },
        { name: "error-sanitization", status: "pass" },
        { name: "secret-leakage", status: "pass" },
        { name: "cargo-audit", status: "pass" },
        { name: "sensitive-logging", status: "pass" },
      ],
      newHighSeverity: 0,
    },
    "t1",
  );
  store.putArtifact(
    MID,
    "sourceTests",
    { discovered: 34, passed: 34, representedAsFixtures: 384 },
    "t1",
  );
}

beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("freezeManifest", () => {
  it("assembles a manifest with both digests and the validation numbers", () => {
    seed();
    const res = freezeManifest(store, MID, "2026-08-28T12:00:00.000Z");
    expect(res.ok).toBe(true);
    const m = res.manifest!;
    expect(m.validation).toEqual({
      dotnetTests: "34/34",
      rustTests: "34/34",
      parity: "384/384",
      clippy: "PASS",
      security: "PASS",
    });
    expect(m.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Manifest(m)).toBe(m.manifestSha256);
    expect(store.getArtifact(MID, "manifest")).toMatchObject({ manifestSha256: m.manifestSha256 });
  });

  it("refuses to freeze without a build / parity / security report", () => {
    store.createMigration({
      id: MID, sourceRepo: "a/b", sourceCommit: "abc1234", sourcePath: "s",
      targetRepo: "a/b", targetBranch: "mh/x", at: "t0",
    });
    expect(freezeManifest(store, MID, "t1")).toMatchObject({ ok: false, reason: /no build report/ });
  });

  it("refuses to freeze when the build lists no files", () => {
    seed({ rustTree: [] });
    expect(freezeManifest(store, MID, "t1")).toMatchObject({ ok: false, reason: /no files/ });
  });

  it("never records security PASS when a mandatory check is missing or skipped", () => {
    seed();
    store.putArtifact(
      MID,
      "security",
      {
        migrationId: MID,
        checks: [
          { name: "input-validation-parity", status: "pass" },
          { name: "error-sanitization", status: "pass" },
          { name: "secret-leakage", status: "pass" },
          { name: "cargo-audit", status: "skip" },
        ],
        newHighSeverity: 0,
      },
      "t2",
    );

    expect(freezeManifest(store, MID, "t3").manifest?.validation.security).toBe("FAIL");
  });
});

describe("reverifyManifest", () => {
  it("passes when nothing has moved since the freeze", () => {
    seed();
    freezeManifest(store, MID, "t1");
    expect(reverifyManifest(store, MID)).toEqual({ ok: true });
  });

  it("fails when a workspace file changed after the freeze (TOCTOU)", () => {
    seed();
    freezeManifest(store, MID, "t1");
    // the build report's tree now lists a different hash for main.rs
    store.putArtifact(
      MID,
      "build",
      {
        migrationId: MID,
        cargoCheck: "PASS",
        cargoTest: { passed: 34, total: 34 },
        clippy: "PASS",
        rustTree: [
          { path: "Cargo.toml", sha256: "a".repeat(64) },
          { path: "src/main.rs", sha256: "f".repeat(64) },
        ],
      },
      "t2",
    );
    expect(reverifyManifest(store, MID)).toMatchObject({ ok: false, reason: /TOCTOU|changed/ });
  });

  it("fails when the stored manifest row was tampered with", () => {
    seed();
    const m = freezeManifest(store, MID, "t1").manifest!;
    const tampered: MigrationManifest = { ...m, targetBranch: "mh/evil" };
    store.putArtifact(MID, "manifest", tampered, "t2");
    expect(reverifyManifest(store, MID)).toMatchObject({ ok: false, reason: /integrity/ });
  });
});
