import { describe, expect, it } from "vitest";
import {
  deriveControlState,
  deriveOperationalSummary,
  deriveParityMetrics,
  derivePipeline,
  normalizeStreamEvent,
} from "./model";
import type { MigrationView } from "./types";

function migration(overrides: Partial<MigrationView> = {}): MigrationView {
  return {
    migrationId: "MH-0042",
    source: { repo: "acme/pricing", commit: "d8091ab", path: "src/Pricing.Api" },
    target: { repo: "acme/pricing-rust", branch: "main" },
    stage: "migrate",
    phase: "running",
    repairRounds: 0,
    terminal: false,
    licenseId: null,
    stages: [],
    gates: [],
    readyToFreeze: false,
    canCutover: false,
    authority: {
      repoRead: true,
      sandbox: true,
      workspaceWrite: true,
      githubPush: "locked",
      merge: "locked",
    },
    pendingInteractions: [],
    history: [],
    evidence: {
      architecture: null,
      contract: null,
      build: null,
      parity: null,
      parityDiagnosis: null,
      security: null,
      manifest: null,
      cutover: null,
    },
    ...overrides,
  };
}

describe("deriveControlState", () => {
  it("uses the contract launcher before a migration is selected", () => {
    expect(deriveControlState(null)).toBe("contract");
  });

  it("routes parity and repair work to the parity inspector", () => {
    expect(deriveControlState(migration({ stage: "parity" }))).toBe("parity");
    expect(deriveControlState(migration({ stage: "repair" }))).toBe("parity");
  });

  it("routes frozen work to the license screen", () => {
    expect(deriveControlState(migration({ stage: "license", phase: "awaiting-license" }))).toBe("license");
  });

  it("routes any terminal migration to the final audit screen", () => {
    expect(deriveControlState(migration({ stage: "repair", phase: "failed", terminal: true }))).toBe("complete");
  });
});

describe("derivePipeline", () => {
  it("marks prior work complete and repair as an active parity loop", () => {
    const pipeline = derivePipeline(migration({ stage: "repair", repairRounds: 1 }));

    expect(pipeline.find((step) => step.id === "discover")?.status).toBe("complete");
    expect(pipeline.find((step) => step.id === "parity")?.status).toBe("active");
    expect(pipeline.find((step) => step.id === "parity")?.detail).toBe("repair round 1 of 3");
    expect(pipeline.find((step) => step.id === "security")?.status).toBe("pending");
  });

  it("marks the current stage failed when the migration is blocked", () => {
    const pipeline = derivePipeline(migration({ stage: "security", phase: "blocked" }));
    expect(pipeline.find((step) => step.id === "security")?.status).toBe("failed");
  });
});

describe("deriveParityMetrics", () => {
  it("returns a safe zero state before parity evidence exists", () => {
    expect(deriveParityMetrics(null)).toEqual({ passed: 0, total: 0, failed: 0, percent: 0 });
  });

  it("clamps malformed evidence to a usable percent", () => {
    expect(deriveParityMetrics({ total: 4, passed: 8, failed: 0, byRoute: [], mismatches: [] })).toEqual({
      passed: 8,
      total: 4,
      failed: 0,
      percent: 100,
    });
  });
});

describe("deriveOperationalSummary", () => {
  it("answers activity, proof and authority from one view", () => {
    const view = migration({
      stage: "parity",
      stages: [
        {
          id: 3,
          migrationId: "MH-0042",
          stage: "parity",
          agent: "mh-parity",
          sessionId: "session-3",
          turnId: "turn-3",
          status: "running",
          lastSeq: 18,
          detail: "Comparing pricing fixtures",
          startedAt: "2026-08-30T10:00:00.000Z",
          finishedAt: null,
        },
      ],
      gates: [
        { id: "discovery", n: 1, title: "Source discovery", status: "pass", detail: "5 endpoints mapped" },
        { id: "contract", n: 2, title: "Migration contract", status: "pass", detail: "5 endpoint contracts" },
        { id: "rust-build", n: 3, title: "Rust compilation & tests", status: "pending", detail: "no build report" },
      ],
    });

    expect(deriveOperationalSummary(view)).toEqual({
      activity: "mh-parity is comparing pricing fixtures",
      proof: "2 of 3 evaluated gates pass",
      authority: "Repository read, sandbox and workspace write. GitHub push locked; merge locked.",
    });
  });
});

describe("normalizeStreamEvent", () => {
  it("unwraps replayed persisted frames", () => {
    expect(
      normalizeStreamEvent({
        id: "22",
        event: "persisted",
        data: {
          seq: 22,
          migrationId: "MH-0042",
          sessionId: null,
          type: "stage.started",
          payload: { stage: "parity" },
          createdAt: "2026-08-30T10:00:00.000Z",
        },
      }),
    ).toEqual({
      seq: 22,
      type: "stage.started",
      payload: { stage: "parity" },
      createdAt: "2026-08-30T10:00:00.000Z",
    });
  });

  it("normalizes named live frames without losing their cursor", () => {
    const result = normalizeStreamEvent(
      { id: "23", event: "stage.completed", data: { stage: "parity" } },
      "2026-08-30T10:00:01.000Z",
    );

    expect(result).toEqual({
      seq: 23,
      type: "stage.completed",
      payload: { stage: "parity" },
      createdAt: "2026-08-30T10:00:01.000Z",
    });
  });
});
