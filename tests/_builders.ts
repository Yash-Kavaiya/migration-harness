/**
 * Fixture builders for the verification suite. Every builder returns a value that
 * already satisfies its zod schema; pass `overrides` to push a single field into
 * the failure region for a specific test.
 *
 * The filename is underscore-prefixed so vitest's `*.spec.ts` glob skips it.
 */
import { buildManifest, type RustTreeEntry } from "@mh/shared/manifest";
import {
  architectureSchema,
  buildReportSchema,
  licenseSchema,
  migrationContractSchema,
  parityReportSchema,
  securityReportSchema,
  type Architecture,
  type BuildReport,
  type MigrationContract,
  type MigrationLicense,
  type MigrationManifest,
  type ParityReport,
  type SecurityReport,
} from "@mh/shared/types";

export const MIGRATION_ID = "MH-0042";
export const SOURCE_REPO = "acme/orderpricing-legacy";
export const TARGET_BRANCH = "migration/MH-0042";

/** A stable three-file Rust tree. Change one entry's hash to simulate tampering. */
export const RUST_TREE: readonly RustTreeEntry[] = [
  { path: "Cargo.toml", sha256: "a".repeat(64) },
  { path: "src/main.rs", sha256: "b".repeat(64) },
  { path: "src/pricing.rs", sha256: "c".repeat(64) },
];

export function architecture(overrides: Partial<Architecture> = {}): Architecture {
  return architectureSchema.parse({
    migrationId: MIGRATION_ID,
    sourceRepo: SOURCE_REPO,
    sourceCommit: "abc1234",
    sourcePath: "src/OrderPricing.Api",
    entrypoint: "Program.cs",
    endpoints: [
      { method: "GET", route: "/health" },
      { method: "POST", route: "/quote", requestDto: "QuoteRequest", responseDto: "QuoteResponse" },
    ],
    components: [{ name: "PricingEngine", riskClass: "RED", reason: "banker's rounding on money" }],
    ...overrides,
  });
}

export function contract(overrides: Partial<MigrationContract> = {}): MigrationContract {
  return migrationContractSchema.parse({
    migrationId: MIGRATION_ID,
    endpoints: [
      {
        method: "GET",
        route: "/health",
        request: {},
        response: { status: "string" },
        compatibility: { statusCode: "exact", jsonFields: "exact", decimalScale: 2 },
      },
      {
        method: "POST",
        route: "/quote",
        request: { subtotal: "number", coupon: "string|null" },
        response: { total: "string", tax: "string" },
        invariants: ["total >= 0", "discount <= subtotal"],
        compatibility: { statusCode: "exact", jsonFields: "exact", decimalScale: 2 },
      },
    ],
    ...overrides,
  });
}

/** byRoute tally covering the two routes in `contract()`, all passing. */
const CLEAN_BY_ROUTE = [
  { method: "GET" as const, route: "/health", passed: 20, total: 20 },
  { method: "POST" as const, route: "/quote", passed: 200, total: 200 },
];

export function parity(overrides: Partial<ParityReport> = {}): ParityReport {
  return parityReportSchema.parse({
    migrationId: MIGRATION_ID,
    total: 220,
    passed: 220,
    failed: 0,
    byRoute: CLEAN_BY_ROUTE,
    mismatches: [],
    ...overrides,
  });
}

/** A parity report with `n` monetary-rounding mismatches on POST /quote. */
export function parityWithMismatches(n: number): ParityReport {
  const mismatches = Array.from({ length: n }, (_, i) => ({
    fixtureId: `fx-${String(i + 1).padStart(4, "0")}`,
    endpoint: { method: "POST" as const, route: "/quote" },
    input: { body: { subtotal: 170.005 } },
    dotnet: { total: "170.00" },
    rust: { total: "169.99" },
    diff: [{ path: "total", expected: "170.00", actual: "169.99" }],
    hypothesis: "monetary rounding: .NET banker's rounding vs Rust half-up",
  }));
  return parity({
    total: 220,
    passed: 220 - n,
    failed: n,
    byRoute: [
      { method: "GET", route: "/health", passed: 20, total: 20 },
      { method: "POST", route: "/quote", passed: 200 - n, total: 200 },
    ],
    mismatches,
  });
}

export function security(overrides: Partial<SecurityReport> = {}): SecurityReport {
  return securityReportSchema.parse({
    migrationId: MIGRATION_ID,
    checks: [
      { name: "input-validation-parity", status: "pass" },
      { name: "error-sanitization", status: "pass" },
      { name: "secret-leakage", status: "pass" },
      { name: "cargo-audit", status: "pass" },
      { name: "sensitive-logging", status: "pass" },
    ],
    newHighSeverity: 0,
    ...overrides,
  });
}

export function build(overrides: Partial<BuildReport> = {}): BuildReport {
  return buildReportSchema.parse({
    migrationId: MIGRATION_ID,
    cargoCheck: "PASS",
    cargoTest: { passed: 34, total: 34 },
    clippy: "PASS",
    rustTree: RUST_TREE.map((e) => ({ path: e.path, sha256: e.sha256 })),
    ...overrides,
  });
}

export function manifest(rustTree: readonly RustTreeEntry[] = RUST_TREE): MigrationManifest {
  return buildManifest({
    migrationId: MIGRATION_ID,
    sourceRepo: SOURCE_REPO,
    sourceCommit: "abc1234",
    targetRepo: SOURCE_REPO,
    targetBranch: TARGET_BRANCH,
    files: { created: 8, modified: 0, deleted: 0 },
    validation: {
      dotnetTests: "34/34",
      rustTests: "34/34",
      parity: "220/220",
      clippy: "PASS",
      security: "PASS",
    },
    rustTree,
    frozenAt: "2026-08-28T12:00:00.000Z",
  });
}

export function license(
  m: MigrationManifest,
  overrides: Partial<MigrationLicense> = {},
): MigrationLicense {
  return licenseSchema.parse({
    licenseId: "LIC-MH-0042-01",
    migrationId: MIGRATION_ID,
    decision: "allow",
    approvedManifestSha256: m.manifestSha256,
    permittedAction: `open PR on ${SOURCE_REPO}`,
    target: `${SOURCE_REPO}:${TARGET_BRANCH}`,
    uses: 1,
    decidedBy: "yash.kavaiya3@gmail.com",
    decidedAt: "2026-08-28T12:05:00.000Z",
    ...overrides,
  });
}

export interface GreenInputs {
  architecture: Architecture;
  contract: MigrationContract;
  build: BuildReport;
  parity: ParityReport;
  security: SecurityReport;
  sourceTests: { discovered: number; representedAsFixtures: number };
  manifest: MigrationManifest;
  license: MigrationLicense;
}

/** Every gate input in its passing state, plus a valid manifest + license. */
export function greenInputs(): GreenInputs {
  const m = manifest();
  return {
    architecture: architecture(),
    contract: contract(),
    build: build(),
    parity: parity(),
    security: security(),
    sourceTests: { discovered: 34, representedAsFixtures: 220 },
    manifest: m,
    license: license(m),
  };
}
