import { initialState } from "@mh/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator, type StageResolver } from "./orchestrator.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";
import { FakeGateway } from "./testing/fake-gateway.js";

let clockValue = 0;
const clock = (): string => new Date(1_700_000_000_000 + clockValue++ * 1000).toISOString();

let store: Store;
let sse: SseHub;
let gateway: FakeGateway;
let orch: Orchestrator;

beforeEach(() => {
  clockValue = 0;
  store = new Store(":memory:");
  sse = new SseHub();
  gateway = new FakeGateway();
  orch = new Orchestrator({ store, gateway, sse, clock });
});

afterEach(async () => {
  await orch.stop();
  store.close();
});

/** Populate the artifacts that gates 1-8 read, so freeze can go green. */
const readyResolver: StageResolver = async ({ stage, store: s, migrationId }) => {
  if (stage === "security") {
    s.putArtifact(migrationId, "architecture", {
      migrationId,
      endpoints: [{ method: "GET", route: "/health" }],
    }, "t");
    s.putArtifact(migrationId, "contract", {
      migrationId,
      endpoints: [{ method: "GET", route: "/health" }],
    }, "t");
    s.putArtifact(migrationId, "build", {
      migrationId,
      cargoCheck: "PASS",
      cargoTest: { passed: 10, total: 10 },
      clippy: "PASS",
      rustTree: [
        { path: "Cargo.toml", sha256: "a".repeat(64) },
        { path: "src/main.rs", sha256: "b".repeat(64) },
      ],
    }, "t");
    s.putArtifact(migrationId, "parity", {
      migrationId,
      total: 50,
      passed: 50,
      failed: 0,
      byRoute: [{ method: "GET", route: "/health", passed: 50, total: 50 }],
      mismatches: [],
    }, "t");
    s.putArtifact(migrationId, "security", {
      migrationId,
      checks: [
        { name: "input-validation-parity", status: "pass" },
        { name: "error-sanitization", status: "pass" },
        { name: "secret-leakage", status: "pass" },
        { name: "cargo-audit", status: "pass" },
        { name: "sensitive-logging", status: "pass" },
      ],
      newHighSeverity: 0,
    }, "t");
    s.putArtifact(migrationId, "sourceTests", { discovered: 10, passed: 10, representedAsFixtures: 50 }, "t");
  }
  return stage === "repair" ? "repaired" : stage === "cutover" ? "cutover-done" : "ok";
};

const START = {
  sourceRepo: "acme/orderpricing-legacy",
  sourceCommit: "abc1234",
  sourcePath: "src/OrderPricing.Api",
};

describe("Orchestrator.start", () => {
  it("creates a migration and kicks off discovery", async () => {
    const { migrationId } = orch.start(START);
    expect(migrationId).toBe("MH-0001");

    await orch.drain();

    const calls = gateway.calls.filter((c) => c.method === "runStage");
    expect(calls[0]?.agentName).toBe("mh-architect");
  });

  it("numbers migrations sequentially", () => {
    orch.start(START);
    const second = orch.start(START);
    expect(second.migrationId).toBe("MH-0002");
  });
});

describe("Orchestrator pipeline (default happy-path resolver)", () => {
  it("runs discover → contract → migrate → parity → security → freeze, then waits", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const view = orch.view(migrationId)!;
    // freeze is orchestrator-run and has no agent, so the loop parks there.
    expect(view.stage).toBe("freeze");
    expect(view.phase).toBe("running");

    const agentsRun = gateway.calls.filter((c) => c.method === "runStage").map((c) => c.agentName);
    expect(agentsRun).toEqual([
      "mh-architect",
      "mh-contract",
      "mh-migrator",
      "mh-parity",
      "mh-security",
    ]);
  });

  it("records a stage run per agent with a session attached", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const runs = store.stageRuns(migrationId);
    const architect = runs.find((r) => r.stage === "discover")!;
    expect(architect.agent).toBe("mh-architect");
    expect(architect.sessionId).toMatch(/^sess-/);
    expect(architect.status).toBe("done");
  });

  it("persists every streamed event so a reconnecting client can catch up", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const events = orch.events(migrationId, 0);
    expect(events.some((e) => e.type === "turn.created")).toBe(true);
    expect(events.some((e) => e.type === "turn.done")).toBe(true);
    expect(events.some((e) => e.type === "stage.started")).toBe(true);
    expect(events.some((e) => e.type === "state")).toBe(true);
    // strictly increasing local sequence
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("lists migrations newest first with their current stage and phase", async () => {
    const first = orch.start(START);
    const second = orch.start({ ...START, sourceCommit: "def5678" });
    await orch.drain();

    expect(orch.list().map((migration) => migration.migrationId)).toEqual([
      second.migrationId,
      first.migrationId,
    ]);
    expect(orch.list()[0]).toMatchObject({ stage: "freeze", phase: "running" });
  });

  it("exposes stored evidence in the migration view", async () => {
    orch.setStageResolver(readyResolver);
    const { migrationId } = orch.start(START);
    await orch.drain();

    expect(orch.view(migrationId)?.evidence).toMatchObject({
      architecture: { migrationId },
      build: { cargoCheck: "PASS" },
      parity: { passed: 50, total: 50 },
      security: { newHighSeverity: 0 },
    });
  });
});

describe("Orchestrator restart recovery", () => {
  it("resumes an in-flight TrueForge turn from its persisted cursor", async () => {
    store.createMigration({
      id: "MH-0001",
      sourceRepo: START.sourceRepo,
      sourceCommit: START.sourceCommit,
      sourcePath: START.sourcePath,
      targetRepo: START.sourceRepo,
      targetBranch: "main",
      at: clock(),
    });
    store.saveState("MH-0001", initialState("MH-0001"), clock());
    const runId = store.startStageRun("MH-0001", "discover", "mh-architect", clock());
    store.attachSession(runId, "sess-existing", "turn-existing");
    store.updateStageRun(runId, { lastSeq: 17 });

    await orch.resumeIncomplete();
    await orch.drain();

    expect(gateway.calls.some((call) => call.method === "resume")).toBe(true);
    expect(orch.view("MH-0001")?.stage).toBe("freeze");
  });

  it("leaves a suspended interaction parked for the human", async () => {
    store.createMigration({
      id: "MH-0001",
      sourceRepo: START.sourceRepo,
      sourceCommit: START.sourceCommit,
      sourcePath: START.sourcePath,
      targetRepo: START.sourceRepo,
      targetBranch: "main",
      at: clock(),
    });
    store.saveState("MH-0001", initialState("MH-0001"), clock());
    const runId = store.startStageRun("MH-0001", "discover", "mh-architect", clock());
    store.attachSession(runId, "sess-existing", "turn-existing");
    store.updateStageRun(runId, { status: "waiting", lastSeq: 17 });

    await orch.resumeIncomplete();
    await orch.drain();

    expect(gateway.calls.some((call) => call.method === "resume")).toBe(false);
    expect(orch.view("MH-0001")?.stage).toBe("discover");
  });
});

describe("Orchestrator gate + license flow", () => {
  it("freezes when gates 1-8 pass and moves to awaiting-license", async () => {
    orch.setStageResolver(readyResolver);
    const { migrationId } = orch.start(START);
    await orch.drain();

    expect(orch.view(migrationId)!.stage).toBe("freeze");

    const freeze = orch.evaluateAndMaybeFreeze(migrationId);
    expect(freeze).toMatchObject({ ok: true, readyToFreeze: true });
    expect(orch.view(migrationId)!.stage).toBe("license");
    expect(orch.view(migrationId)!.phase).toBe("awaiting-license");
  });

  it("blocks at freeze when a gate is red", async () => {
    orch.setStageResolver(async ({ stage }) => (stage === "repair" ? "repaired" : "ok"));
    const { migrationId } = orch.start(START);
    await orch.drain();

    const freeze = orch.evaluateAndMaybeFreeze(migrationId);
    expect(freeze).toMatchObject({ ok: true, readyToFreeze: false });
    expect(orch.view(migrationId)!.phase).toBe("blocked");
  });

  it("lets a human redirect a blocked migration to an earlier agent stage", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);

    expect(orch.retryBlocked(migrationId, "parity")).toEqual({ ok: true });
    expect(orch.view(migrationId)).toMatchObject({ stage: "parity", phase: "running" });
    await orch.drain();
    expect(orch.view(migrationId)?.stage).toBe("freeze");
  });

  it("rejects redirects while a migration is not blocked", () => {
    const { migrationId } = orch.start(START);
    expect(orch.retryBlocked(migrationId, "parity")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/blocked/),
    });
  });

  it("rejects a license decision when not awaiting one", () => {
    const { migrationId } = orch.start(START);
    const res = orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not awaiting/);
  });

  it("allow → mints a license, runs cutover, consumes the license", async () => {
    orch.setStageResolver(readyResolver);
    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);

    const decision = orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    expect(decision).toMatchObject({ ok: true });
    expect(decision.licenseId).toMatch(/^LIC-MH-0001-\d\d$/);
    await orch.drain();

    const view = orch.view(migrationId)!;
    expect(view.stage).toBe("complete");
    expect(view.terminal).toBe(true);
    expect(view.licenseId).toBe(decision.licenseId);
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(true);

    const license = store.getLicenseById(decision.licenseId!)!;
    expect(license.uses).toBe(0);
    expect(license.consumedAt).toBeTruthy();
  });

  it("deny → terminal, no license minted", async () => {
    orch.setStageResolver(readyResolver);
    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);

    orch.decideLicense(migrationId, { decision: "deny", decidedBy: "yash@example.com", reason: "wants a staging soak" });
    await orch.drain();

    expect(orch.view(migrationId)!.phase).toBe("denied");
    expect(store.getLicense(migrationId)?.decision).toBe("deny");
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(false);
  });
});

describe("Orchestrator cutover approvals", () => {
  it("answers a cutover GitHub-write approval automatically with the license", async () => {
    gateway.script("mh-cutover", { pauseForApproval: "tc-cutover-1" });
    orch.setStageResolver(readyResolver);

    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);
    orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    await orch.drain();

    // No human interaction needed — the license authorized the write.
    expect(orch.view(migrationId)!.stage).toBe("complete");
    expect(orch.view(migrationId)!.pendingInteractions).toHaveLength(0);
  });

  it("continues routing every licensed write until the pull request is opened", async () => {
    gateway.script("mh-cutover", {
      approvalSequence: [
        { id: "tc-branch", name: "create_branch" },
        { id: "tc-files", name: "push_files" },
        { id: "tc-pr", name: "create_pull_request" },
      ],
    });
    orch.setStageResolver(readyResolver);

    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);
    orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    await orch.drain();

    expect(orch.view(migrationId)!.stage).toBe("complete");
    expect(gateway.calls.filter((call) => call.method === "reply")).toHaveLength(3);
    expect(orch.view(migrationId)!.evidence.cutover).toMatchObject({
      status: "approved",
      tool: "create_pull_request",
      toolCallId: "tc-pr",
    });
  });
});
