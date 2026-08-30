import assert from "node:assert/strict";
import { DemoGateway } from "../apps/orchestrator/src/demo-gateway.js";
import { Orchestrator, type MigrationView } from "../apps/orchestrator/src/orchestrator.js";
import { buildServer } from "../apps/orchestrator/src/server.js";
import { SseHub } from "../apps/orchestrator/src/sse.js";
import { makeStageResolver } from "../apps/orchestrator/src/stages/resolver.js";
import { Store } from "../apps/orchestrator/src/store.js";

const store = new Store(":memory:");
const gateway = new DemoGateway();
const orchestrator = new Orchestrator({ store, gateway, sse: new SseHub() });
orchestrator.setStageResolver(makeStageResolver());
const app = await buildServer({ orchestrator, webOrigin: "http://localhost:3000", mode: "demo" });

try {
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok", mode: "demo" });

  const started = await app.inject({
    method: "POST",
    url: "/api/migrations",
    payload: {
      sourceRepo: "demo/orderpricing-legacy",
      sourceCommit: "d8091ab",
      sourcePath: "demo/OrderPricingService/src/OrderPricing.Api",
      targetRepo: "demo/orderpricing-rust",
      targetBranch: "migration/demo",
    },
  });
  assert.equal(started.statusCode, 200);
  const migrationId = (started.json() as { migrationId: string }).migrationId;

  await orchestrator.drain();
  let view = orchestrator.view(migrationId)!;
  assert.equal(view.stage, "freeze");
  assert.equal(view.repairRounds, 1);
  assert.equal(view.evidence.parity?.passed, 384);
  assert.equal(view.readyToFreeze, true);

  const frozen = await app.inject({ method: "POST", url: `/api/migrations/${migrationId}/freeze` });
  assert.equal(frozen.statusCode, 200);
  view = orchestrator.view(migrationId)!;
  assert.equal(view.phase, "awaiting-license");
  assert.match(view.evidence.manifest?.manifestSha256 ?? "", /^[0-9a-f]{64}$/);

  const licensed = await app.inject({
    method: "POST",
    url: `/api/migrations/${migrationId}/license`,
    payload: { decision: "allow", decidedBy: "demo.operator@migrationharness.dev" },
  });
  assert.equal(licensed.statusCode, 200);
  await orchestrator.drain();

  const completed = await app.inject({ method: "GET", url: `/api/migrations/${migrationId}` });
  assert.equal(completed.statusCode, 200);
  view = completed.json<MigrationView>();
  assert.equal(view.phase, "complete");
  assert.equal(view.pendingInteractions.length, 0);

  const license = store.getLicense(migrationId);
  assert.equal(license?.uses, 0);
  assert.ok(license?.consumedAt);

  const events = orchestrator.events(migrationId, 0);
  assert.ok(events.length > 20);
  assert.ok(events.some((event) => event.type === "license.granted"));
  assert.ok(events.some((event) => event.type === "license.consumed"));

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "demo",
        migrationId,
        repairRounds: view.repairRounds,
        parity: `${view.evidence.parity?.passed}/${view.evidence.parity?.total}`,
        finalStage: view.stage,
        finalPhase: view.phase,
        licenseId: license?.licenseId,
        licenseUsesRemaining: license?.uses,
        persistedEvents: events.length,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await orchestrator.stop();
  store.close();
}
