import { describe, expect, it } from "vitest";
import {
  buildManifest,
  canonicalize,
  hashRustTree,
  nextLicenseId,
  sha256,
  sha256Manifest,
  type RustTreeEntry,
} from "@mh/shared/manifest";
import { manifest, RUST_TREE } from "./_builders.js";

describe("canonicalize", () => {
  it("is insensitive to key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ x: { p: 1, q: 2 } })).toBe(canonicalize({ x: { q: 2, p: 1 } }));
  });

  it("preserves array order (arrays are ordered data)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("produces a stable string for the same structure", () => {
    const value = { migrationId: "MH-0042", files: { deleted: 0, created: 8, modified: 0 } };
    expect(canonicalize(value)).toBe('{"files":{"created":8,"deleted":0,"modified":0},"migrationId":"MH-0042"}');
  });
});

describe("sha256", () => {
  it("matches the known digest of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("hashRustTree", () => {
  const tree: RustTreeEntry[] = [
    { path: "src/main.rs", sha256: "b".repeat(64) },
    { path: "Cargo.toml", sha256: "a".repeat(64) },
  ];

  it("is independent of listing order", () => {
    expect(hashRustTree(tree)).toBe(hashRustTree([...tree].reverse()));
  });

  it("changes when any file's content hash changes", () => {
    const mutated = tree.map((e, i) => (i === 0 ? { ...e, sha256: "f".repeat(64) } : e));
    expect(hashRustTree(mutated)).not.toBe(hashRustTree(tree));
  });

  it("changes when a file is added or removed", () => {
    const withExtra = [...tree, { path: "src/lib.rs", sha256: "c".repeat(64) }];
    expect(hashRustTree(withExtra)).not.toBe(hashRustTree(tree));
  });
});

describe("buildManifest / sha256Manifest", () => {
  it("stamps a manifestSha256 that recomputes to itself", () => {
    const m = manifest();
    expect(m.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Manifest(m)).toBe(m.manifestSha256);
  });

  it("derives rustTreeSha256 from the supplied tree", () => {
    const m = manifest();
    expect(m.rustTreeSha256).toBe(hashRustTree(RUST_TREE));
  });

  it("is deterministic — same inputs, same hashes", () => {
    expect(manifest()).toEqual(manifest());
  });

  it("excludes only the digest field itself from the digest", () => {
    const m = manifest();
    const { manifestSha256: _omit, ...rest } = m;
    expect(sha256(canonicalize(rest))).toBe(m.manifestSha256);
  });
});

describe("nextLicenseId", () => {
  it("formats as LIC-MH-<id>-<seq>", () => {
    expect(nextLicenseId("MH-0042", 1)).toBe("LIC-MH-0042-01");
    expect(nextLicenseId("MH-0007", 12)).toBe("LIC-MH-0007-12");
  });
});
