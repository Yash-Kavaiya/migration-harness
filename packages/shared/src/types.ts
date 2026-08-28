import { z } from "zod";

/**
 * Runtime types mirrored from `schemas/*.schema.json`. The JSON Schemas are the
 * contract agents are held to; these zod types are what the orchestrator and UI
 * validate against after pulling an artifact out of the sandbox.
 */

export const MIGRATION_ID = /^MH-\d{4}$/;
export const LICENSE_ID = /^LIC-MH-\d{4}-\d{2}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export const migrationIdSchema = z.string().regex(MIGRATION_ID);
export const sha256Schema = z.string().regex(SHA256_HEX);

export const riskClassSchema = z.enum(["GREEN", "YELLOW", "RED"]);

export const architectureSchema = z.object({
  migrationId: migrationIdSchema,
  sourceRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  sourcePath: z.string().min(1),
  entrypoint: z.string().min(1),
  endpoints: z
    .array(
      z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        route: z.string().startsWith("/"),
        requestDto: z.string().nullable().optional(),
        responseDto: z.string().nullable().optional(),
        handler: z.string().optional(),
      }),
    )
    .min(1),
  domainServices: z.array(z.string()).optional(),
  validators: z.array(z.string()).optional(),
  dependencies: z
    .array(
      z.object({
        name: z.string(),
        version: z.string().optional(),
        kind: z.enum(["nuget", "framework", "project"]).optional(),
      }),
    )
    .optional(),
  tests: z.array(z.string()).optional(),
  components: z
    .array(z.object({ name: z.string(), riskClass: riskClassSchema, reason: z.string().optional() }))
    .min(1),
  unsupported: z
    .array(z.object({ component: z.string(), reason: z.string() }))
    .optional(),
});
export type Architecture = z.infer<typeof architectureSchema>;

export const migrationContractSchema = z.object({
  migrationId: migrationIdSchema,
  endpoints: z
    .array(
      z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        route: z.string().startsWith("/"),
        request: z.record(z.string()),
        response: z.record(z.string()),
        invariants: z.array(z.string()).optional(),
        compatibility: z.object({
          statusCode: z.literal("exact"),
          jsonFields: z.enum(["exact", "superset-allowed"]),
          decimalScale: z.number().int().min(0).max(8),
          nullSemantics: z.enum(["exact", "lenient"]).optional(),
        }),
        errors: z
          .array(
            z.object({
              status: z.number().int().min(400).max(599),
              when: z.string(),
              bodyShape: z.record(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});
export type MigrationContract = z.infer<typeof migrationContractSchema>;

export const parityReportSchema = z.object({
  migrationId: migrationIdSchema,
  rustCommitSha: z.string().optional(),
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  byRoute: z.array(
    z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      route: z.string().startsWith("/"),
      passed: z.number().int().min(0),
      total: z.number().int().min(0),
    }),
  ),
  mismatches: z.array(
    z.object({
      fixtureId: z.string().regex(/^fx-\d{4}$/),
      endpoint: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        route: z.string().startsWith("/"),
      }),
      input: z.unknown(),
      dotnet: z.unknown(),
      rust: z.unknown(),
      diff: z.array(z.object({ path: z.string(), expected: z.unknown(), actual: z.unknown() })),
      hypothesis: z.string().optional(),
    }),
  ),
});
export type ParityReport = z.infer<typeof parityReportSchema>;

export const securityReportSchema = z.object({
  migrationId: migrationIdSchema,
  checks: z
    .array(
      z.object({
        name: z.enum([
          "input-validation-parity",
          "error-sanitization",
          "secret-leakage",
          "cargo-audit",
          "sensitive-logging",
        ]),
        status: z.enum(["pass", "fail", "skip"]),
        detail: z.string().optional(),
      }),
    )
    .min(1),
  newHighSeverity: z.number().int().min(0),
});
export type SecurityReport = z.infer<typeof securityReportSchema>;

export const buildReportSchema = z.object({
  migrationId: migrationIdSchema,
  cargoCheck: z.enum(["PASS", "FAIL"]),
  cargoTest: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
  clippy: z.enum(["PASS", "FAIL"]),
  rustTree: z.array(z.object({ path: z.string(), sha256: sha256Schema })),
});
export type BuildReport = z.infer<typeof buildReportSchema>;

export const migrationManifestSchema = z.object({
  migrationId: migrationIdSchema,
  sourceRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  targetRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  targetBranch: z.string().min(1),
  files: z.object({
    created: z.number().int().min(0),
    modified: z.number().int().min(0),
    deleted: z.number().int().min(0),
  }),
  validation: z.object({
    dotnetTests: z.string().regex(/^\d+\/\d+$/),
    rustTests: z.string().regex(/^\d+\/\d+$/),
    parity: z.string().regex(/^\d+\/\d+$/),
    clippy: z.enum(["PASS", "FAIL"]),
    security: z.enum(["PASS", "FAIL"]),
  }),
  rustTreeSha256: sha256Schema,
  manifestSha256: sha256Schema,
  frozenAt: z.string().datetime().optional(),
});
export type MigrationManifest = z.infer<typeof migrationManifestSchema>;

export const licenseSchema = z.object({
  licenseId: z.string().regex(LICENSE_ID),
  migrationId: migrationIdSchema,
  decision: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
  approvedManifestSha256: sha256Schema,
  permittedAction: z.string(),
  target: z.string(),
  uses: z.number().int().min(0).max(1),
  consumedAt: z.string().datetime().nullable().optional(),
  invalidatedAt: z.string().datetime().nullable().optional(),
  invalidationReason: z.string().nullable().optional(),
  decidedBy: z.string(),
  decidedAt: z.string().datetime(),
});
export type MigrationLicense = z.infer<typeof licenseSchema>;
