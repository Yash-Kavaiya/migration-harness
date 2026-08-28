/**
 * The production {@link StageResolver}: after an agent's turn completes, pull its
 * artifact out of the workspace, validate it against the shared JSON Schema,
 * store it for the gate engine, and return the state-machine outcome.
 *
 * Everything here is fail-closed. A missing or malformed artifact is never
 * treated as a pass — discovery/contract/security throw (unrecoverable without a
 * human), migrate/parity/repair degrade to a bounded repair round.
 */
import {
  architectureSchema,
  buildReportSchema,
  classifyMismatch,
  migrationContractSchema,
  parityReportSchema,
  securityReportSchema,
  type MismatchCategory,
  type StageOutcome,
} from "@mh/shared";
import type { z } from "zod";
import type { StageResolver } from "../orchestrator.js";
import { parseRepairVerdict } from "../repair-loop.js";
import { downloadJson, isParseFailure } from "./artifacts.js";

/** Artifact each agent writes into the workspace, by stage. */
export const STAGE_ARTIFACT: Record<string, string> = {
  discover: "architecture.json",
  contract: "migration-contract.json",
  migrate: "build-report.json",
  parity: "parity-report.json",
  security: "security-report.json",
  repair: "repair-log.json",
};

class StageArtifactError extends Error {
  constructor(stage: string, detail: string) {
    super(`${stage}: ${detail}`);
    this.name = "StageArtifactError";
  }
}

function parseOrThrow<T>(stage: string, schema: z.ZodType<T>, raw: unknown): T {
  if (isParseFailure(raw)) {
    throw new StageArtifactError(stage, `agent artifact was not valid JSON (${raw.raw.slice(0, 200)})`);
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    throw new StageArtifactError(stage, `artifact failed schema validation — ${res.error.issues[0]?.message ?? "unknown"}`);
  }
  return res.data;
}

export interface StageResolverOptions {
  /** Override artifact names (tests, or a workspace layout change). */
  artifactNames?: Partial<Record<string, string>>;
}

export function makeStageResolver(opts: StageResolverOptions = {}): StageResolver {
  const names = { ...STAGE_ARTIFACT, ...opts.artifactNames };

  return async ({ stage, gateway, store, migrationId, sessionId, turnId, at }): Promise<StageOutcome> => {
    const session = { sessionId, turnId };
    const artifactOf = (): string => {
      const n = names[stage];
      if (!n) throw new StageArtifactError(stage, "no workspace artifact is configured for this stage");
      return n;
    };

    switch (stage) {
      case "discover": {
        const arch = parseOrThrow("discover", architectureSchema, await downloadJson(gateway, session, artifactOf()));
        store.putArtifact(migrationId, "architecture", arch, at);
        return arch.unsupported && arch.unsupported.length > 0 ? "unsupported" : "ok";
      }

      case "contract": {
        const contract = parseOrThrow("contract", migrationContractSchema, await downloadJson(gateway, session, artifactOf()));
        store.putArtifact(migrationId, "contract", contract, at);
        return "ok";
      }

      case "migrate": {
        const build = parseOrThrow("migrate", buildReportSchema, await downloadJson(gateway, session, artifactOf()));
        store.putArtifact(migrationId, "build", build, at);
        const ok = build.cargoCheck === "PASS" && build.cargoTest.total > 0 && build.cargoTest.passed === build.cargoTest.total;
        return ok ? "ok" : "build-failed";
      }

      case "parity": {
        const report = parseOrThrow("parity", parityReportSchema, await downloadJson(gateway, session, artifactOf()));

        // Cross-check the agent's headline numbers against its own mismatch list;
        // reconcile `failed` up if it under-reported.
        const failed = Math.max(report.failed, report.mismatches.length);
        const reconciled = { ...report, failed, passed: Math.max(0, report.total - failed) };
        store.putArtifact(migrationId, "parity", reconciled, at);

        // Diagnosis for the timeline/UI — one category per failing fixture, the
        // most common wins. Never fed back to mh-repair.
        const counts = new Map<MismatchCategory, number>();
        for (const m of report.mismatches) {
          const diffs = m.diff.map((d) => ({ path: d.path, expected: d.expected, actual: d.actual }));
          const cat = classifyMismatch(diffs, { decimalScale: 2 });
          counts.set(cat, (counts.get(cat) ?? 0) + 1);
        }
        const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        store.putArtifact(migrationId, "parityDiagnosis", { dominant, counts: Object.fromEntries(counts) }, at);

        const clean = reconciled.failed === 0 && reconciled.total > 0;
        return clean ? "ok" : "mismatch";
      }

      case "security": {
        const sec = parseOrThrow("security", securityReportSchema, await downloadJson(gateway, session, artifactOf()));
        store.putArtifact(migrationId, "security", sec, at);
        return "ok";
      }

      case "repair": {
        const raw = await downloadJson(gateway, session, artifactOf());
        // The log is advisory. `escalate` means the agent gave up; anything else
        // sends the migration back through the authoritative `parity` re-run.
        // A missing/garbled log fails closed to a bounded retry, never a pass.
        const status =
          !isParseFailure(raw) && raw && typeof raw === "object"
            ? String((raw as { status?: unknown }).status ?? "")
            : "";
        store.putArtifact(migrationId, "repairLog", isParseFailure(raw) ? { status: "unparseable" } : raw, at);

        if (/^escalate$/i.test(status)) return "escalate";
        const verdict = parseRepairVerdict(JSON.stringify(raw));
        if (verdict.status === "fixed") return "repaired";
        return "build-failed";
      }

      case "cutover":
        return "cutover-done";

      default:
        return "ok";
    }
  };
}
