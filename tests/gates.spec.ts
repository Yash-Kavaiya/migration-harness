import { describe, expect, it } from "vitest";
import { canCutover, evaluateGates, readyToFreeze, type GateInputs } from "@mh/shared/gates";
import { greenInputs, license, manifest, parityWithMismatches, security } from "./_builders.js";

describe("evaluateGates", () => {
  it("returns 9 gates, numbered 1-9 in pipeline order", () => {
    const gates = evaluateGates(greenInputs());
    expect(gates).toHaveLength(9);
    expect(gates.map((g) => g.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gates.map((g) => g.id)).toEqual([
      "discovery",
      "contract",
      "rust-build",
      "source-tests-preserved",
      "behavioral-parity",
      "api-compatibility",
      "clippy",
      "security",
      "human-license",
    ]);
  });

  it("passes every gate for a fully green migration", () => {
    const gates = evaluateGates(greenInputs());
    expect(gates.every((g) => g.status === "pass")).toBe(true);
    expect(readyToFreeze(gates)).toBe(true);
    expect(canCutover(gates)).toBe(true);
  });

  it("leaves gates pending when no inputs are supplied", () => {
    const gates = evaluateGates({});
    expect(gates.every((g) => g.status === "pending")).toBe(true);
    expect(readyToFreeze(gates)).toBe(false);
    expect(canCutover(gates)).toBe(false);
  });
});

describe("canCutover is blocked by any red gate", () => {
  it("blocks on failed behavioral parity", () => {
    const gates = evaluateGates({ ...greenInputs(), parity: parityWithMismatches(3) });
    const parityGate = gates.find((g) => g.id === "behavioral-parity");
    expect(parityGate?.status).toBe("fail");
    expect(readyToFreeze(gates)).toBe(false);
    expect(canCutover(gates)).toBe(false);
  });

  it("blocks on failed security (new high-severity issues)", () => {
    const gates = evaluateGates({ ...greenInputs(), security: security({ newHighSeverity: 2 }) });
    expect(gates.find((g) => g.id === "security")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("does NOT pass security when checks are merely skipped (must actually run)", () => {
    const skipped = security({
      checks: [
        { name: "input-validation-parity", status: "skip" },
        { name: "error-sanitization", status: "skip" },
        { name: "secret-leakage", status: "skip" },
        { name: "cargo-audit", status: "skip" },
        { name: "sensitive-logging", status: "skip" },
      ],
      newHighSeverity: 0,
    });
    const gates = evaluateGates({ ...greenInputs(), security: skipped });
    expect(gates.find((g) => g.id === "security")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("does NOT pass security when a required check is missing entirely", () => {
    const partial = security({
      checks: [
        { name: "input-validation-parity", status: "pass" },
        { name: "secret-leakage", status: "pass" },
      ],
      newHighSeverity: 0,
    });
    const gates = evaluateGates({ ...greenInputs(), security: partial });
    expect(gates.find((g) => g.id === "security")?.status).toBe("fail");
  });

  it("blocks on a failing security check even with zero new high-severity", () => {
    const broken = security({
      checks: [
        { name: "input-validation-parity", status: "pass" },
        { name: "error-sanitization", status: "fail", detail: "stack trace leaked in 500 body" },
        { name: "secret-leakage", status: "pass" },
        { name: "cargo-audit", status: "pass" },
        { name: "sensitive-logging", status: "pass" },
      ],
      newHighSeverity: 0,
    });
    const gates = evaluateGates({ ...greenInputs(), security: broken });
    expect(gates.find((g) => g.id === "security")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("blocks api-compatibility when a contract route was never exercised by a fixture", () => {
    const inputs = greenInputs();
    const gates = evaluateGates({
      ...inputs,
      // parity is 100% clean and reconciles, but only /health has fixtures —
      // /quote (also in the contract) was never exercised
      parity: {
        ...inputs.parity,
        total: 20,
        passed: 20,
        failed: 0,
        byRoute: [{ method: "GET", route: "/health", passed: 20, total: 20 }],
      },
    });
    const g6 = gates.find((g) => g.id === "api-compatibility")!;
    expect(g6.status).toBe("fail");
    expect(g6.detail).toMatch(/never tested/);
    expect(canCutover(gates)).toBe(false);
  });

  it("blocks api-compatibility when a duplicate route entry hides a failing tally", () => {
    const inputs = greenInputs();
    const gates = evaluateGates({
      ...inputs,
      parity: {
        ...inputs.parity,
        total: 40,
        passed: 30,
        failed: 10,
        byRoute: [
          { method: "GET", route: "/health", passed: 20, total: 20 },
          { method: "POST", route: "/quote", passed: 0, total: 10 }, // failing
          { method: "POST", route: "/quote", passed: 10, total: 10 }, // "passing" duplicate
        ],
      },
    });
    expect(gates.find((g) => g.id === "api-compatibility")?.status).toBe("fail");
  });

  it("blocks api-compatibility when byRoute tallies do not reconcile with the totals", () => {
    const inputs = greenInputs();
    const gates = evaluateGates({
      ...inputs,
      parity: {
        ...inputs.parity,
        total: 500, // claims 500 fixtures...
        passed: 500,
        failed: 0,
        byRoute: [
          { method: "GET", route: "/health", passed: 20, total: 20 },
          { method: "POST", route: "/quote", passed: 200, total: 200 }, // ...but only 220 accounted for
        ],
      },
    });
    const g6 = gates.find((g) => g.id === "api-compatibility")!;
    expect(g6.status).toBe("fail");
    expect(g6.detail).toMatch(/reconcile/);
  });

  it("blocks security when a failed check is followed by a passing entry of the same name", () => {
    const dup = security({
      checks: [
        { name: "cargo-audit", status: "fail", detail: "RUSTSEC-2024-xxxx" },
        { name: "cargo-audit", status: "pass" },
        { name: "input-validation-parity", status: "pass" },
        { name: "error-sanitization", status: "pass" },
        { name: "secret-leakage", status: "pass" },
        { name: "sensitive-logging", status: "pass" },
      ],
      newHighSeverity: 0,
    });
    const gates = evaluateGates({ ...greenInputs(), security: dup });
    expect(gates.find((g) => g.id === "security")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("blocks on a red clippy result", () => {
    const inputs = greenInputs();
    const gates = evaluateGates({ ...inputs, build: { ...inputs.build, clippy: "FAIL" } });
    expect(gates.find((g) => g.id === "clippy")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("blocks when the Rust build has failing tests", () => {
    const inputs = greenInputs();
    const gates = evaluateGates({
      ...inputs,
      build: { ...inputs.build, cargoTest: { passed: 33, total: 34 } },
    });
    expect(gates.find((g) => g.id === "rust-build")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("blocks when fewer xUnit cases are represented as fixtures than were discovered", () => {
    const gates = evaluateGates({
      ...greenInputs(),
      sourceTests: { discovered: 34, representedAsFixtures: 30 },
    });
    expect(gates.find((g) => g.id === "source-tests-preserved")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("halts discovery when the source uses an unsupported component", () => {
    const inputs = greenInputs();
    const gates = evaluateGates({
      ...inputs,
      architecture: {
        ...inputs.architecture,
        unsupported: [{ component: "SignalR hub", reason: "no websockets in scope" }],
      },
    });
    expect(gates.find((g) => g.id === "discovery")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });
});

describe("gate 9 — human license", () => {
  it("is pending (not failed) when gates 1-8 are green but no license exists", () => {
    const inputs: GateInputs = { ...greenInputs(), license: null };
    const gates = evaluateGates(inputs);
    expect(gates.find((g) => g.id === "human-license")?.status).toBe("pending");
    // The manifest can be frozen; the cutover cannot run.
    expect(readyToFreeze(gates)).toBe(true);
    expect(canCutover(gates)).toBe(false);
  });

  it("is pending when the manifest has not been frozen", () => {
    const gates = evaluateGates({ ...greenInputs(), manifest: null, license: null });
    expect(gates.find((g) => g.id === "human-license")?.status).toBe("pending");
    expect(canCutover(gates)).toBe(false);
  });

  it("fails when the recorded license is a denial", () => {
    const m = manifest();
    const gates = evaluateGates({
      ...greenInputs(),
      manifest: m,
      license: license(m, { decision: "deny", reason: "wants a staging soak first" }),
    });
    expect(gates.find((g) => g.id === "human-license")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });

  it("fails when the license was issued against a different manifest hash", () => {
    const gates = evaluateGates({
      ...greenInputs(),
      license: license(manifest(), { approvedManifestSha256: "0".repeat(64) }),
    });
    expect(gates.find((g) => g.id === "human-license")?.status).toBe("fail");
    expect(canCutover(gates)).toBe(false);
  });
});
