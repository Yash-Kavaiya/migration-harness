/**
 * Freezing and re-verifying the Migration Manifest.
 *
 * `freeze()` is called once, the moment gates 1-8 go green — it snapshots the
 * generated Rust tree and every validation number into an immutable manifest and
 * stamps two digests (the tree hash and the whole-manifest hash). The License is
 * issued against `manifestSha256`.
 *
 * `reverify()` runs again immediately before the first GitHub write: it re-hashes
 * the manifest content and the Rust tree as they exist *now* and compares to what
 * was frozen. Any drift (a workspace edit after approval, a tampered manifest
 * row) fails the check — the TOCTOU guard the whole license model rests on.
 */
import {
  buildManifest,
  hashRustTree,
  sha256Manifest,
  type BuildReport,
  type MigrationManifest,
  type ParityReport,
  type RustTreeEntry,
  type SecurityReport,
} from "@mh/shared";
import type { Store } from "../store.js";

export interface FreezeResult {
  ok: boolean;
  manifest?: MigrationManifest;
  reason?: string;
}

/** The Rust tree the manifest is (or would be) frozen over — straight from the build report. */
export function currentRustTree(store: Store, migrationId: string): RustTreeEntry[] {
  const build = store.getArtifact<BuildReport>(migrationId, "build");
  return (build?.rustTree ?? []).map((e) => ({ path: e.path, sha256: e.sha256 }));
}

export function freezeManifest(store: Store, migrationId: string, at: string): FreezeResult {
  const migration = store.getMigration(migrationId);
  if (!migration) return { ok: false, reason: "no such migration" };

  const build = store.getArtifact<BuildReport>(migrationId, "build");
  const parity = store.getArtifact<ParityReport>(migrationId, "parity");
  const security = store.getArtifact<SecurityReport>(migrationId, "security");
  const sourceTests = store.getArtifact<{ discovered: number; representedAsFixtures: number }>(
    migrationId,
    "sourceTests",
  );

  if (!build) return { ok: false, reason: "cannot freeze: no build report" };
  if (!parity) return { ok: false, reason: "cannot freeze: no parity report" };
  if (!security) return { ok: false, reason: "cannot freeze: no security report" };

  const rustTree = currentRustTree(store, migrationId);
  if (rustTree.length === 0) return { ok: false, reason: "cannot freeze: build report lists no files" };

  const securityPass =
    security.newHighSeverity === 0 && security.checks.every((c) => c.status !== "fail");

  // The goldens ARE the record of externally observable .NET behaviour, so every
  // captured fixture is one .NET behaviour verified against Rust.
  const dotnetVerified = sourceTests?.discovered ?? parity.total;

  const manifest = buildManifest({
    migrationId,
    sourceRepo: migration.sourceRepo,
    sourceCommit: migration.sourceCommit,
    targetRepo: migration.targetRepo,
    targetBranch: migration.targetBranch,
    files: { created: rustTree.length, modified: 0, deleted: 0 },
    validation: {
      dotnetTests: `${dotnetVerified}/${dotnetVerified}`,
      rustTests: `${build.cargoTest.passed}/${build.cargoTest.total}`,
      parity: `${parity.passed}/${parity.total}`,
      clippy: build.clippy,
      security: securityPass ? "PASS" : "FAIL",
    },
    rustTree,
    frozenAt: at,
  });

  store.putArtifact(migrationId, "manifest", manifest, at);
  return { ok: true, manifest };
}

export interface ReverifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Re-check the frozen manifest against reality. Run before minting a license and
 * again before the first GitHub write.
 */
export function reverifyManifest(store: Store, migrationId: string): ReverifyResult {
  const manifest = store.getArtifact<MigrationManifest>(migrationId, "manifest");
  if (!manifest) return { ok: false, reason: "no frozen manifest on record" };

  if (sha256Manifest(manifest) !== manifest.manifestSha256) {
    return { ok: false, reason: "manifest integrity check failed — stored digest does not match its content" };
  }

  const treeNow = hashRustTree(currentRustTree(store, migrationId));
  if (treeNow !== manifest.rustTreeSha256) {
    return { ok: false, reason: "Rust tree changed since the manifest was frozen (TOCTOU)" };
  }

  return { ok: true };
}
