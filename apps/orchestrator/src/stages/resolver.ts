/**
 * The production {@link StageResolver}: after an agent's turn completes, pull its
 * artifact out of the workspace, validate it against the shared JSON Schema,
 * confirm it belongs to this migration, store it for the gate engine, and return
 * the state-machine outcome.
 *
 * Fail-closed, two ways:
 *  - discover / contract / security throw on a bad artifact — the pipeline cannot
 *    proceed without a valid one and a human must look;
 *  - migrate / parity recover a bad artifact into a bounded repair round
 *    (`build-failed` / `mismatch`), storing the raw payload as evidence. The
 *    state machine's `MAX_REPAIR_ROUNDS` stops a stuck agent.
 */
import {
  architectureSchema,
  buildReportSchema,
  classifyMismatch,
  migrationContractSchema,
  parityReportSchema,
  securityReportSchema,
  type MismatchCategory,
  type ParityReport,
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

type ParseAttempt<T> = { ok: true; data: T } | { ok: false; detail: string };

/** Validate shape + migration identity without throwing. */
function tryParse<T extends { migrationId: string }>(
  schema: z.ZodType<T>,
  raw: unknown,
  migrationId: string,
): ParseAttempt<T> {
  if (isParseFailure(raw)) {
    return { ok: false, detail: `artifact was not valid JSON (${raw.raw.slice(0, 200)})` };
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    return { ok: false, detail: `schema validation failed — ${res.error.issues[0]?.message ?? "unknown"}` };
  }
  if (res.data.migrationId !== migrationId) {
    return {
      ok: false,
      detail: `artifact is for ${res.data.migrationId}, not ${migrationId}`,
    };
  }
  return { ok: true, data: res.data };
}

function parseOrThrow<T extends { migrationId: string }>(
  stage: string,
  schema: z.ZodType<T>,
  raw: unknown,
  migrationId: string,
): T {
  const res = tryParse(schema, raw, migrationId);
  if (!res.ok) throw new StageArtifactError(stage, res.detail);
  return res.data;
}

/**
 * The parity report's own headline numbers must be internally consistent. We
 * reconcile `failed` *up* to match the mismatch list (an agent can under-count
 * failures) but never invent passing fixtures, and we reject a report whose
 * totals contradict themselves. Per-route passing counts are recomputed from the
 * mismatch attribution so a stale `byRoute` cannot mask a failure at the gate.
 */
function reconcileParity(report: ParityReport): ParityReport {
  const listedFailures = report.mismatches.length;
  const failed = Math.max(report.failed, listedFailures);
  const passed = report.total - failed;

  if (passed < 0) {
    throw new StageArtifactError("parity", `${listedFailures} mismatches exceed total ${report.total}`);
  }
  if (report.passed + report.failed !== report.total) {
    throw new StageArtifactError(
      "parity",
      `inconsistent totals: passed ${report.passed} + failed ${report.failed} ≠ total ${report.total}`,
    );
  }
  if (report.byRoute.length > 0) {
    const routeTotal = report.byRoute.reduce((s, r) => s + r.total, 0);
    if (routeTotal !== report.total) {
      throw new StageArtifactError("parity", `byRoute totals sum to ${routeTotal}, not ${report.total}`);
    }
  }

  // Recompute per-route passing from the mismatch list.
  const failsByRoute = new Map<string, number>();
  for (const m of report.mismatches) {
    const key = `${m.endpoint.method} ${m.endpoint.route}`;
    failsByRoute.set(key, (failsByRoute.get(key) ?? 0) + 1);
  }
  const byRoute = report.byRoute.map((r) => {
    const fails = failsByRoute.get(`${r.method} ${r.route}`) ?? 0;
    return { ...r, passed: Math.max(0, r.total - fails) };
  });

  return { ...report, failed, passed, byRoute };
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
        const arch = parseOrThrow("discover", architectureSchema, await downloadJson(gateway, session, artifactOf()), migrationId);
        store.putArtifact(migrationId, "architecture", arch, at);
        return arch.unsupported && arch.unsupported.length > 0 ? "unsupported" : "ok";
      }

      case "contract": {
        const contract = parseOrThrow("contract", migrationContractSchema, await downloadJson(gateway, session, artifactOf()), migrationId);
        store.putArtifact(migrationId, "contract", contract, at);

        // Optional companion file: how many .NET xUnit cases exist and how many
        // are represented as goldens. Feeds gate 4 (source-tests-preserved).
        const plan = await downloadJson(gateway, session, "fixture-plan.json");
        if (!isParseFailure(plan) && plan && typeof plan === "object") {
          const p = plan as { fixtures?: unknown; dotnetTestCases?: unknown };
          const fixtures = Number(p.fixtures);
          const cases = Number(p.dotnetTestCases);
          if (Number.isFinite(fixtures) && Number.isFinite(cases)) {
            store.putArtifact(migrationId, "sourceTests", { discovered: cases, representedAsFixtures: fixtures }, at);
          }
        }
        return "ok";
      }

      case "migrate": {
        const parsed = tryParse(buildReportSchema, await downloadJson(gateway, session, artifactOf()), migrationId);
        if (!parsed.ok) {
          store.putArtifact(migrationId, "buildFailure", { detail: parsed.detail }, at);
          return "build-failed"; // recoverable — back into a bounded repair round
        }
        store.putArtifact(migrationId, "build", parsed.data, at);
        const t = parsed.data.cargoTest;
        const ok = parsed.data.cargoCheck === "PASS" && t.total > 0 && t.passed === t.total;
        return ok ? "ok" : "build-failed";
      }

      case "parity": {
        const parsed = tryParse(parityReportSchema, await downloadJson(gateway, session, artifactOf()), migrationId);
        if (!parsed.ok) {
          store.putArtifact(migrationId, "parityFailure", { detail: parsed.detail }, at);
          return "mismatch"; // recoverable — can't confirm parity, so don't advance
        }

        const report = reconcileParity(parsed.data);
        store.putArtifact(migrationId, "parity", report, at);

        // Diagnosis for the timeline/UI — one category per failing fixture, the
        // most common wins. Never fed back to mh-repair.
        const counts = new Map<MismatchCategory, number>();
        for (const m of parsed.data.mismatches) {
          const diffs = m.diff.map((d) => ({ path: d.path, expected: d.expected, actual: d.actual }));
          const cat = classifyMismatch(diffs, { decimalScale: 2 });
          counts.set(cat, (counts.get(cat) ?? 0) + 1);
        }
        const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        store.putArtifact(migrationId, "parityDiagnosis", { dominant, counts: Object.fromEntries(counts) }, at);

        return report.failed === 0 && report.total > 0 ? "ok" : "mismatch";
      }

      case "security": {
        const sec = parseOrThrow("security", securityReportSchema, await downloadJson(gateway, session, artifactOf()), migrationId);
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
