import { describe, expect, it } from "vitest";
import {
  hashRustTree,
  verifyCutoverPreconditions,
  verifyLicense,
  type RustTreeEntry,
} from "@mh/shared/manifest";
import { license, manifest, RUST_TREE } from "./_builders.js";

/**
 * The window between "human grants the license" and "cutover agent makes the first
 * GitHub write" is where a tampered or regenerated Rust tree could slip through.
 * `verifyCutoverPreconditions` closes it by re-hashing the tree at write time.
 */
describe("TOCTOU: the Rust tree must not change after the license is granted", () => {
  it("passes when the tree at cutover is byte-identical to what was frozen", () => {
    const m = manifest();
    const lic = license(m);
    expect(verifyCutoverPreconditions(lic, m, RUST_TREE).ok).toBe(true);
  });

  it("rejects cutover when a file's content changed after licensing", () => {
    const m = manifest();
    const lic = license(m);

    const tampered: RustTreeEntry[] = RUST_TREE.map((e) =>
      e.path === "src/pricing.rs" ? { ...e, sha256: "9".repeat(64) } : e,
    );

    const result = verifyCutoverPreconditions(lic, m, tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/tree changed|TOCTOU/i);
  });

  it("rejects cutover when a file was added to the tree after licensing", () => {
    const m = manifest();
    const lic = license(m);
    const withExtra = [...RUST_TREE, { path: "src/backdoor.rs", sha256: "e".repeat(64) }];

    expect(verifyCutoverPreconditions(lic, m, withExtra).ok).toBe(false);
  });

  it("still enforces the license checks before the tree check", () => {
    const m = manifest();
    const denied = license(m, { decision: "deny" });
    const result = verifyCutoverPreconditions(denied, m, RUST_TREE);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/allow/i);
  });
});

describe("manifest integrity", () => {
  it("rejects a manifest whose stored digest no longer matches its content", () => {
    const m = manifest();
    const lic = license(m);

    // Someone edited the frozen manifest in place without recomputing the digest.
    const tampered = { ...m, targetBranch: "migration/evil" };

    const result = verifyLicense(lic, tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/integrity/i);
  });

  it("rejects when the frozen rustTreeSha256 was swapped", () => {
    const m = manifest();
    const lic = license(m);
    const tampered = { ...m, rustTreeSha256: hashRustTree([{ path: "x", sha256: "0".repeat(64) }]) };
    expect(verifyLicense(lic, tampered).ok).toBe(false);
  });
});
