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

  // 6 — api compatibility. Passes only when BOTH hold:
  //   (a) every contract route was actually exercised — it appears in the parity
  //       report's per-route tally with total > 0 and passed === total; and
  //   (b) aggregate parity is 100%.
  // A contract route with no fixtures fails the gate rather than passing silently.
  if (!inp.contract || !inp.parity) results.push(gate("api-compatibility", 6, "pending", "needs contract + parity"));
  else {
    const contractRoutes: string[] = inp.contract.endpoints.map((e) => `${e.method} ${e.route}`);
    // Defensive: the orchestrator stores artifacts as raw JSON, so guard against a
    // report that predates the byRoute field rather than throwing on every view().
    const byRoute = (inp.parity.byRoute ?? []) as ParityReport["byRoute"];

    // SUM all entries per route — a duplicate key must not let a later passing
    // tally overwrite an earlier failing one.
    const tallyByRoute = new Map<string, { passed: number; total: number }>();
    for (const r of byRoute) {
      const key = `${r.method} ${r.route}`;
      const acc = tallyByRoute.get(key) ?? { passed: 0, total: 0 };
      tallyByRoute.set(key, { passed: acc.passed + r.passed, total: acc.total + r.total });
    }

    const uncovered = contractRoutes.filter((r) => (tallyByRoute.get(r)?.total ?? 0) === 0);
    const brokenRoutes = contractRoutes.filter((r) => {
      const t = tallyByRoute.get(r);
      return t && t.total > 0 && t.passed !== t.total;
    });

    // The per-route tallies must reconcile with the aggregate, or the report is
    // internally inconsistent and can't be trusted.
    const routeTotal = byRoute.reduce((s, r) => s + r.total, 0);
    const routePassed = byRoute.reduce((s, r) => s + r.passed, 0);
    const reconciles = routeTotal === inp.parity.total && routePassed === inp.parity.passed;

    const parityClean = inp.parity.total > 0 && inp.parity.passed === inp.parity.total;
    const ok =
      uncovered.length === 0 && brokenRoutes.length === 0 && reconciles && parityClean;

    let detail: string;
    if (uncovered.length > 0) detail = `${uncovered.length} contract route(s) never tested: ${uncovered.join(", ")}`;
    else if (brokenRoutes.length > 0) detail = `mismatches on ${brokenRoutes.join(", ")}`;
    else if (!reconciles) detail = `byRoute tally (${routePassed}/${routeTotal}) does not reconcile with totals (${inp.parity.passed}/${inp.parity.total})`;
    else if (!parityClean) detail = `parity not clean (${inp.parity.passed}/${inp.parity.total})`;
    else detail = `${contractRoutes.length} contract route(s) covered, parity clean`;

    results.push(gate("api-compatibility", 6, ok ? "pass" : "fail", detail));
  }

  // 7 — clippy
  if (!inp.build) results.push(gate("clippy", 7, "pending", "no build report"));
  else results.push(gate("clippy", 7, inp.build.clippy === "PASS" ? "pass" : "fail", `clippy ${inp.build.clippy}`));

  // 8 — security. A safety gate. Every one of the five checks must have a `pass`
  // entry and NO `fail` entry (the schema allows duplicate names, so we can't just
  // take the last status — any explicit failure sinks the gate). "skip" never
  // counts as passing.
  if (!inp.security) results.push(gate("security", 8, "pending", "security scan not run"));
  else {
    const anyFail = inp.security.checks.some((c) => c.status === "fail");
    const passedNames = new Set(
      inp.security.checks.filter((c) => c.status === "pass").map((c) => c.name),
    );
    const failedNames = new Set(
      inp.security.checks.filter((c) => c.status === "fail").map((c) => c.name),
    );
    const notOk = SECURITY_CHECKS.filter((n) => !passedNames.has(n) || failedNames.has(n));
    const ok = !anyFail && notOk.length === 0 && inp.security.newHighSeverity === 0;
    const detail =
      anyFail || notOk.length > 0
        ? `checks not satisfied: ${(anyFail ? [...failedNames].map((n) => `${n}=fail`) : [])
            .concat(notOk.filter((n) => !failedNames.has(n)).map((n) => `${n}=missing/skip`))
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
