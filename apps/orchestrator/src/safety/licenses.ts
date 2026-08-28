/**
 * The single-use Migration License nonce.
 *
 * A license authorises exactly one thing: opening the cutover PR against the
 * manifest's frozen target. It is minted only after a human records `allow` and
 * the manifest re-verifies, carries `uses: 1`, and is spent (`uses: 0`,
 * `consumedAt` set) the instant the PR is created. Any later workspace drift
 * invalidates it. The pure predicates live in `@mh/shared` (`verifyLicense`,
 * `verifyCutoverPreconditions`, `consumeLicense`, `invalidateLicense`); this
 * wraps them with storage and id sequencing.
 */
import {
  consumeLicense,
  invalidateLicense,
  nextLicenseId,
  verifyLicense,
  type MigrationLicense,
  type MigrationManifest,
} from "@mh/shared";
import type { Store } from "../store.js";

export interface MintInput {
  migrationId: string;
  manifest: MigrationManifest;
  decidedBy: string;
  /** e.g. `open PR on acme/legacy`. */
  permittedAction: string;
  /** e.g. `acme/legacy:mh/MH-0001`. */
  target: string;
  at: string;
  reason?: string | undefined;
}

export class LicenseService {
  constructor(private readonly store: Store) {}

  /** Issue the nonce. The caller must have re-verified the manifest first. */
  mint(input: MintInput): MigrationLicense {
    const seq = this.store.countLicenses(input.migrationId) + 1;
    const license: MigrationLicense = {
      licenseId: nextLicenseId(input.migrationId, seq),
      migrationId: input.migrationId,
      decision: "allow",
      ...(input.reason ? { reason: input.reason } : {}),
      approvedManifestSha256: input.manifest.manifestSha256,
      permittedAction: input.permittedAction,
      target: input.target,
      uses: 1,
      consumedAt: null,
      invalidatedAt: null,
      decidedBy: input.decidedBy,
      decidedAt: input.at,
    };
    this.store.putLicense(license, input.at);
    return license;
  }

  /** Record a denial — kept for the audit trail; never authorises anything. */
  recordDenial(migrationId: string, decidedBy: string, reason: string, at: string): MigrationLicense {
    const seq = this.store.countLicenses(migrationId) + 1;
    const license: MigrationLicense = {
      licenseId: nextLicenseId(migrationId, seq),
      migrationId,
      decision: "deny",
      reason,
      approvedManifestSha256: "0".repeat(64),
      permittedAction: "none",
      target: "none",
      uses: 0,
      decidedBy,
      decidedAt: at,
    };
    this.store.putLicense(license, at);
    return license;
  }

  current(migrationId: string): MigrationLicense | null {
    return this.store.getLicense(migrationId);
  }

  /** Is there a live, manifest-matched license right now? */
  check(migrationId: string, manifest: MigrationManifest): { ok: boolean; reason?: string } {
    const license = this.store.getLicense(migrationId);
    const res = verifyLicense(license, manifest);
    return res.ok ? { ok: true } : { ok: false, reason: res.reason ?? "license invalid" };
  }

  consume(licenseId: string, at: string): void {
    const license = this.store.getLicenseById(licenseId);
    if (!license) throw new Error(`no such license: ${licenseId}`);
    this.store.putLicense(consumeLicense(license, at), at);
  }

  invalidate(licenseId: string, at: string, reason: string): void {
    const license = this.store.getLicenseById(licenseId);
    if (!license) return;
    this.store.putLicense(invalidateLicense(license, at, reason), at);
  }
}
