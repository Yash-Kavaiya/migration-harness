import { describe, expect, it } from "vitest";
import {
  consumeLicense,
  invalidateLicense,
  verifyCutoverPreconditions,
  verifyLicense,
} from "@mh/shared/manifest";
import { license, manifest, RUST_TREE } from "./_builders.js";

describe("a license is single-use", () => {
  it("verifies once, then never again after it is consumed", () => {
    const m = manifest();
    const lic = license(m);

    expect(verifyLicense(lic, m).ok).toBe(true);

    const spent = consumeLicense(lic, "2026-08-28T12:30:00.000Z");
    expect(spent.uses).toBe(0);
    expect(spent.consumedAt).toBe("2026-08-28T12:30:00.000Z");

    const result = verifyLicense(spent, m);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/consumed/i);
  });

  it("rejects a second cutover attempt with the consumed license", () => {
    const m = manifest();
    const lic = consumeLicense(license(m), "2026-08-28T12:30:00.000Z");
    expect(verifyCutoverPreconditions(lic, m, RUST_TREE).ok).toBe(false);
  });

  it("treats uses=0 as spent even if consumedAt was never written", () => {
    const m = manifest();
    const lic = license(m, { uses: 0 });
    expect(verifyLicense(lic, m).ok).toBe(false);
  });
});

describe("a license can be invalidated", () => {
  it("stops verifying once invalidated, carrying the reason", () => {
    const m = manifest();
    const lic = invalidateLicense(
      license(m),
      "2026-08-28T12:31:00.000Z",
      "Rust tree changed after authorization",
    );
    expect(lic.uses).toBe(0);
    expect(lic.invalidatedAt).toBe("2026-08-28T12:31:00.000Z");

    const result = verifyLicense(lic, m);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/invalidated/i);
    expect(result.reason).toContain("Rust tree changed after authorization");
  });
});

describe("a fresh, matching license", () => {
  it("passes all cutover preconditions", () => {
    const m = manifest();
    expect(verifyCutoverPreconditions(license(m), m, RUST_TREE)).toEqual({ ok: true });
  });
});
