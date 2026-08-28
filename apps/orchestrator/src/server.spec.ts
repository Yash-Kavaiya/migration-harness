import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Orchestrator } from "./orchestrator.js";
import { buildServer } from "./server.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";
import { FakeGateway } from "./testing/fake-gateway.js";

let app: FastifyInstance;
let store: Store;
let orch: Orchestrator;
let clockValue = 0;

beforeEach(async () => {
  clockValue = 0;
  store = new Store(":memory:");
  orch = new Orchestrator({
    store,
    gateway: new FakeGateway(),
    sse: new SseHub(),
    clock: () => new Date(1_700_000_000_000 + clockValue++ * 1000).toISOString(),
  });
  app = await buildServer({ orchestrator: orch, webOrigin: "http://localhost:3000" });
});

afterEach(async () => {
  await app.close();
  await orch.stop();
  store.close();
});

const START = {
  sourceRepo: "acme/orderpricing-legacy",
  sourceCommit: "abc1234",
  sourcePath: "src/OrderPricing.Api",
};

describe("POST /api/migrations", () => {
  it("starts a migration and returns its id", async () => {
    const res = await app.inject({ method: "POST", url: "/api/migrations", payload: START });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ migrationId: "MH-0001" });
  });

  it("rejects a malformed source repo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/migrations",
      payload: { ...START, sourceRepo: "not-a-repo" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/migrations/:id", () => {
  it("404s for an unknown migration", async () => {
    const res = await app.inject({ method: "GET", url: "/api/migrations/MH-9999" });
    expect(res.statusCode).toBe(404);
  });

  it("returns the full view with a gate grid", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const res = await app.inject({ method: "GET", url: `/api/migrations/${migrationId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.migrationId).toBe(migrationId);
    expect(body.gates).toHaveLength(9);
    expect(body.authority).toMatchObject({ githubPush: "locked", merge: "locked" });
  });
});

describe("POST /api/migrations/:id/license", () => {
  it("409s when the migration is not awaiting a license", async () => {
    const { migrationId } = orch.start(START);
    const res = await app.inject({
      method: "POST",
      url: `/api/migrations/${migrationId}/license`,
      payload: { decision: "allow", decidedBy: "yash@example.com" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a decision with no decidedBy", async () => {
    const { migrationId } = orch.start(START);
    const res = await app.inject({
      method: "POST",
      url: `/api/migrations/${migrationId}/license`,
      payload: { decision: "allow" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/migrations/:id/events", () => {
  it("streams persisted events then stays open", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const res = await app.inject({
      method: "GET",
      url: `/api/migrations/${migrationId}/events`,
      payloadAsStream: true,
    });
    // header check is enough here; full SSE behaviour is covered by SseHub tests
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    res.stream().destroy();
  });
});
