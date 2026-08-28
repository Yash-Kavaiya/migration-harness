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
      rustTree: [],
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
    s.putArtifact(migrationId, "sourceTests", { discovered: 10, representedAsFixtures: 50 }, "t");
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
    // strictly increasing local sequence
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
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

  it("rejects a license decision when not awaiting one", () => {
    const { migrationId } = orch.start(START);
    const res = orch.decideLicense(migrationId, { decision: "allow", licenseId: "LIC-MH-0001-01" });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not awaiting/);
  });

  it("allow → runs cutover; deny → terminal", async () => {
    orch.setStageResolver(readyResolver);
    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);

    orch.decideLicense(migrationId, { decision: "allow", licenseId: "LIC-MH-0001-01" });
    await orch.drain();

    const view = orch.view(migrationId)!;
    expect(view.stage).toBe("complete");
    expect(view.terminal).toBe(true);
    expect(view.licenseId).toBe("LIC-MH-0001-01");
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(true);
  });
});

describe("Orchestrator human-in-the-loop (approval)", () => {
  it("surfaces a pending approval and resumes the stage once answered", async () => {
    gateway.script("mh-cutover", { pauseForApproval: "tc-cutover-1" });
    orch.setStageResolver(readyResolver);

    const { migrationId } = orch.start(START);
    await orch.drain();
    orch.evaluateAndMaybeFreeze(migrationId);
    orch.decideLicense(migrationId, { decision: "allow", licenseId: "LIC-MH-0001-01" });
    await orch.drain();

    // cutover paused for approval
    const cutoverRun = store.stageRuns(migrationId).find((r) => r.stage === "cutover")!;
    expect(cutoverRun.status).toBe("waiting");

    const view = orch.view(migrationId)!;
    expect(view.pendingInteractions).toHaveLength(1);
    const [pending] = view.pendingInteractions;
    expect(pending!.kind).toBe("approval");

    const answered = orch.answerInteraction(pending!.eventId, { kind: "approval", status: "allow" });
    expect(answered.ok).toBe(true);
    await orch.drain();

    expect(orch.view(migrationId)!.stage).toBe("complete");
    expect(orch.view(migrationId)!.pendingInteractions).toHaveLength(0);
  });
});
