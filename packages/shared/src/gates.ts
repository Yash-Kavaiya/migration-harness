import { verifyLicense } from "./manifest.js";
import type {
  Architecture,
  BuildReport,
  MigrationContract,
  MigrationLicense,
  MigrationManifest,
  ParityReport,
  SecurityReport,
} from "./types.js";

export type GateId =
  | "discovery"
  | "contract"
  | "rust-build"
  | "source-tests-preserved"
  | "behavioral-parity"
  | "api-compatibility"
  | "clippy"
  | "security"
  | "human-license";

export type GateStatus = "pass" | "fail" | "pending";

export interface GateResult {
  id: GateId;
  n: number;
  title: string;
  status: GateStatus;
  detail: string;
}

export interface GateInputs {
  architecture?: Architecture | null;
  contract?: MigrationContract | null;
  build?: BuildReport | null;
  parity?: ParityReport | null;
  security?: SecurityReport | null;
  /** Number of xUnit test cases discovered vs. represented as fixtures. */
  sourceTests?: { discovered: number; representedAsFixtures: number } | null;
  manifest?: MigrationManifest | null;
  license?: MigrationLicense | null;
}

/** The five checks a security report must carry, all passing, for gate 8. */
export const SECURITY_CHECKS = [
  "input-validation-parity",
  "error-sanitization",
  "secret-leakage",
  "cargo-audit",
  "sensitive-logging",
] as const;

const TITLES: Record<GateId, string> = {
  discovery: "Source discovery",
  contract: "Migration contract",
  "rust-build": "Rust compilation & tests",
  "source-tests-preserved": "Existing tests preserved",
  "behavioral-parity": "Behavioral parity",
  "api-compatibility": "API compatibility",
  clippy: "cargo clippy",
  security: "Security validation",
  "human-license": "Human license",
};

function gate(id: GateId, n: number, status: GateStatus, detail: string): GateResult {
  return { id, n, title: TITLES[id], status, detail };
}

/** Evaluate all 9 gates. Order matches the pipeline; missing inputs read as `pending`. */
export function evaluateGates(inp: GateInputs): GateResult[] {
  const results: GateResult[] = [];

  // 1 — discovery
  if (!inp.architecture) results.push(gate("discovery", 1, "pending", "architecture.json not produced yet"));
  else if (inp.architecture.unsupported && inp.architecture.unsupported.length > 0) {
    results.push(
      gate("discovery", 1, "fail", `${inp.architecture.unsupported.length} unsupported component(s)`),
    );
  } else {
    results.push(gate("discovery", 1, "pass", `${inp.architecture.endpoints.length} endpoint(s) mapped`));
  }

  // 2 — contract
  if (!inp.contract) results.push(gate("contract", 2, "pending", "migration-contract.yaml not produced yet"));
  else if (inp.contract.endpoints.length < 1) results.push(gate("contract", 2, "fail", "no endpoints in contract"));
  else results.push(gate("contract", 2, "pass", `${inp.contract.endpoints.length} endpoint contract(s)`));

  // 3 — rust build
  if (!inp.build) results.push(gate("rust-build", 3, "pending", "no build report"));
  else {
    const t = inp.build.cargoTest;
    const ok = inp.build.cargoCheck === "PASS" && t.total > 0 && t.passed === t.total;
    results.push(
      gate("rust-build", 3, ok ? "pass" : "fail", `cargo check ${inp.build.cargoCheck}, tests ${t.passed}/${t.total}`),
    );
  }

  // 4 — source tests preserved
  if (!inp.sourceTests) results.push(gate("source-tests-preserved", 4, "pending", "test coverage not computed"));
  else {
    const ok =
      inp.sourceTests.discovered > 0 &&
      inp.sourceTests.representedAsFixtures >= inp.sourceTests.discovered;
    results.push(
      gate(
        "source-tests-preserved",
        4,
        ok ? "pass" : "fail",
        `${inp.sourceTests.representedAsFixtures}/${inp.sourceTests.discovered} xUnit cases covered by fixtures`,
      ),
    );
  }

  // 5 — behavioral parity
  if (!inp.parity) results.push(gate("behavioral-parity", 5, "pending", "parity not run"));
  else {
    const ok = inp.parity.total > 0 && inp.parity.passed === inp.parity.total && inp.parity.failed === 0;
    results.push(
      gate("behavioral-parity", 5, ok ? "pass" : "fail", `${inp.parity.passed}/${inp.parity.total} fixtures`),
    );
  }

  // 6 — api compatibility. Passes only when parity is 100% (so no route can be
  // silently incompatible) AND every contract route was actually exercised by a
  // fixture. Route attribution of failures is best-effort on top of that.
  if (!inp.contract || !inp.parity) results.push(gate("api-compatibility", 6, "pending", "needs contract + parity"));
  else {
    const contractRoutes = new Set(inp.contract.endpoints.map((e) => `${e.method} ${e.route}`));
    const mismatchRoutes = new Set(
      inp.parity.mismatches.map((m) => `${m.endpoint.method} ${m.endpoint.route}`),
    );
    const brokenContractRoutes = [...contractRoutes].filter((r) => mismatchRoutes.has(r));
    const parityClean = inp.parity.total > 0 && inp.parity.passed === inp.parity.total;

    let detail: string;
    if (!parityClean) {
      detail = `parity not clean (${inp.parity.passed}/${inp.parity.total})` +
        (brokenContractRoutes.length > 0
          ? `; mismatches on ${brokenContractRoutes.join(", ")}`
          : inp.parity.mismatches.length > 0
            ? `; ${inp.parity.mismatches.length} mismatch(es) on non-contract routes`
            : "");
    } else {
      detail = `${contractRoutes.size} contract route(s), parity clean`;
    }
    results.push(gate("api-compatibility", 6, parityClean ? "pass" : "fail", detail));
  }

  // 7 — clippy
  if (!inp.build) results.push(gate("clippy", 7, "pending", "no build report"));
  else results.push(gate("clippy", 7, inp.build.clippy === "PASS" ? "pass" : "fail", `clippy ${inp.build.clippy}`));

  // 8 — security. A safety gate: every one of the five checks must have actually
  // run and passed. "skip" does not count — a report that runs nothing must not
  // unlock the gate.
  if (!inp.security) results.push(gate("security", 8, "pending", "security scan not run"));
  else {
    const status = new Map(inp.security.checks.map((c) => [c.name, c.status]));
    const notPassed = SECURITY_CHECKS.filter((name) => status.get(name) !== "pass");
    const ok = notPassed.length === 0 && inp.security.newHighSeverity === 0;
    const detail =
      notPassed.length > 0
        ? `${notPassed.length} check(s) not passed: ${notPassed
            .map((n) => `${n}=${status.get(n) ?? "missing"}`)
            .join(", ")}`
        : `${inp.security.newHighSeverity} new high-severity issue(s)`;
    results.push(gate("security", 8, ok ? "pass" : "fail", detail));
  }

  // 9 — human license
  if (!inp.manifest) results.push(gate("human-license", 9, "pending", "manifest not frozen"));
  else {
    const v = verifyLicense(inp.license ?? null, inp.manifest);
    results.push(gate("human-license", 9, v.ok ? "pass" : inp.license ? "fail" : "pending", v.reason ?? "licensed"));
  }

  return results;
}

/** Gates 1-8 that must all pass before the manifest is frozen and the License card unlocks. */
export function readyToFreeze(gates: GateResult[]): boolean {
  return gates.filter((g) => g.n >= 1 && g.n <= 8).every((g) => g.status === "pass");
}

/**
 * The single predicate the cutover stage checks. Requires every gate green — which
 * includes gate 9 (a valid, unconsumed, hash-matched license).
 */
export function canCutover(gates: GateResult[]): boolean {
  return gates.length === 9 && gates.every((g) => g.status === "pass");
}
