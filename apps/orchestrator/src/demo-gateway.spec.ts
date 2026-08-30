import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoGateway } from "./demo-gateway.js";
import { Orchestrator } from "./orchestrator.js";
import { SseHub } from "./sse.js";
import { makeStageResolver } from "./stages/resolver.js";
import { Store } from "./store.js";
import { confirmCutover } from "./testing/confirm-cutover.js";

const START = {
  sourceRepo: "demo/orderpricing-legacy",
  sourceCommit: "d8091ab",
  sourcePath: "demo/OrderPricingService/src/OrderPricing.Api",
  targetRepo: "demo/orderpricing-rust",
  targetBranch: "migration/demo",
};

let store: Store;
let gateway: DemoGateway;
let orchestrator: Orchestrator;

beforeEach(() => {
  store = new Store(":memory:");
  gateway = new DemoGateway();
  orchestrator = new Orchestrator({ store, gateway, sse: new SseHub() });
  orchestrator.setStageResolver(makeStageResolver());
});

afterEach(async () => {
  await orchestrator.stop();
  store.close();
});

describe("DemoGateway", () => {
  it("drives the semantic mismatch through one repair round to a licensable manifest", async () => {
    const { migrationId } = orchestrator.start(START);
    await orchestrator.drain();

    const beforeFreeze = orchestrator.view(migrationId)!;
    expect(beforeFreeze.stage).toBe("freeze");
    expect(beforeFreeze.repairRounds).toBe(1);
    expect(beforeFreeze.evidence.parity).toMatchObject({ total: 384, passed: 384, failed: 0 });
    expect(beforeFreeze.evidence.parityDiagnosis).toMatchObject({ dominant: null });
    expect(beforeFreeze.readyToFreeze).toBe(true);

    expect(orchestrator.evaluateAndMaybeFreeze(migrationId)).toMatchObject({
      ok: true,
      readyToFreeze: true,
    });
    expect(orchestrator.view(migrationId)?.phase).toBe("awaiting-license");
  });

  it("uses the license to simulate exactly one pull request and completes", async () => {
    const { migrationId } = orchestrator.start(START);
    await orchestrator.drain();
    orchestrator.evaluateAndMaybeFreeze(migrationId);

    const decision = orchestrator.decideLicense(migrationId, {
      decision: "allow",
      decidedBy: "demo.operator@migrationharness.dev",
    });
    expect(decision.ok).toBe(true);
    await confirmCutover(orchestrator, migrationId);

    const view = orchestrator.view(migrationId)!;
    expect(view.phase).toBe("complete");
    expect(view.pendingInteractions).toHaveLength(0);
    expect(gateway.calls.filter((call) => call.agentName === "mh-cutover")).toHaveLength(1);
    expect(store.getLicenseById(decision.licenseId!)?.uses).toBe(0);
  });
});
