/**
 * Level-1 verification (from the build plan): the whole discover → … → parity →
 * repair → parity → freeze loop, driven end to end by the real state machine and
 * the real stage resolver, against a scripted TrueForge. Zero tokens, zero live
 * services — the decimal trap fires and the repair clears it in replay.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../orchestrator.js";
import { SseHub } from "../sse.js";
import { Store } from "../store.js";
import { FakeGateway } from "../testing/fake-gateway.js";
import { makeStageResolver } from "./resolver.js";

let clockN = 0;
const clock = (): string => new Date(1_700_000_000_000 + clockN++ * 1000).toISOString();

let store: Store;
let sse: SseHub;
let gateway: FakeGateway;
let orch: Orchestrator;

const START = { sourceRepo: "acme/orderpricing", sourceCommit: "abc1234", sourcePath: "src/OrderPricing.Api" };

const architecture = {
  migrationId: "MH-0001",
  sourceRepo: "acme/orderpricing",
  sourceCommit: "abc1234",
  sourcePath: "src/OrderPricing.Api",
  entrypoint: "Program.cs",
  endpoints: [
    { method: "GET", route: "/health" },
    { method: "POST", route: "/quote", requestDto: "QuoteRequest", responseDto: "QuoteResponse" },
  ],
  components: [{ name: "PricingEngine", riskClass: "RED", reason: "banker's rounding" }],
};

const contract = {
  migrationId: "MH-0001",
  endpoints: [
    {
      method: "POST",
      route: "/quote",
      request: { subtotal: "number", coupon: "string|null" },
      response: { total: "string", tax: "string" },
      compatibility: { statusCode: "exact", jsonFields: "exact", decimalScale: 2 },
    },
  ],
};

const build = {
  migrationId: "MH-0001",
  cargoCheck: "PASS",
  cargoTest: { passed: 34, total: 34 },
  clippy: "PASS",
  rustTree: [
    { path: "Cargo.toml", sha256: "a".repeat(64) },
    { path: "src/main.rs", sha256: "b".repeat(64) },
  ],
};

const trapMismatch = (i: number) => ({
  fixtureId: `fx-${String(i).padStart(4, "0")}`,
  endpoint: { method: "POST", route: "/quote" },
  input: { body: { subtotal: 249.95, coupon: "SUMMER10" } },
  dotnet: { status: 200, body: { total: "244.08", tax: "19.12" } },
  rust: { status: 200, body: { total: "244.07", tax: "19.12" } },
  diff: [{ path: "body.total", expected: "244.08", actual: "244.07" }],
});

const parityWithTrap = {
  migrationId: "MH-0001",
  total: 384,
  passed: 378,
  failed: 6,
  byRoute: [{ method: "POST", route: "/quote", passed: 378, total: 384 }],
  mismatches: [1, 2, 3, 4, 5, 6].map(trapMismatch),
};

const parityClean = {
  migrationId: "MH-0001",
  total: 384,
  passed: 384,
  failed: 0,
  byRoute: [{ method: "POST", route: "/quote", passed: 384, total: 384 }],
  mismatches: [],
};

const security = {
  migrationId: "MH-0001",
  checks: [
    { name: "input-validation-parity", status: "pass" },
    { name: "error-sanitization", status: "pass" },
    { name: "secret-leakage", status: "pass" },
    { name: "cargo-audit", status: "pass" },
    { name: "sensitive-logging", status: "pass" },
  ],
  newHighSeverity: 0,
};

const j = (v: unknown) => JSON.stringify(v);

beforeEach(() => {
  clockN = 0;
  store = new Store(":memory:");
  sse = new SseHub();
  gateway = new FakeGateway();
  orch = new Orchestrator({ store, gateway, sse, clock });
  orch.setStageResolver(makeStageResolver());

  gateway.script("mh-architect", { artifacts: { "architecture.json": j(architecture) } });
  gateway.script("mh-contract", { artifacts: { "migration-contract.json": j(contract) } });
  gateway.script("mh-migrator", { artifacts: { "build-report.json": j(build) } });
  gateway.scriptEach("mh-parity", [
    { artifacts: { "parity-report.json": j(parityWithTrap) } },
    { artifacts: { "parity-report.json": j(parityClean) } },
  ]);
  gateway.script("mh-repair", { artifacts: { "repair-log.json": j({ status: "resolved", category: "DECIMAL_ROUNDING" }) } });
  gateway.script("mh-security", { artifacts: { "security-report.json": j(security) } });
});

afterEach(async () => {
  await orch.stop();
  store.close();
});

describe("the decimal-trap loop, end to end in replay", () => {
  it("runs discover → contract → migrate → parity(trap) → repair → parity(clean) → security → freeze", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const view = orch.view(migrationId)!;
    expect(view.stage).toBe("freeze");
    expect(view.phase).toBe("running");
    expect(view.repairRounds).toBe(1);

    const agents = gateway.calls.filter((c) => c.method === "runStage").map((c) => c.agentName);
    expect(agents).toEqual([
      "mh-architect",
      "mh-contract",
      "mh-migrator",
      "mh-parity",
      "mh-repair",
      "mh-parity",
      "mh-security",
    ]);
  });

  it("clears the trap after repair — the final stored parity is the clean re-run", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    expect(store.getArtifact<{ failed: number; passed: number }>(migrationId, "parity")).toMatchObject({
      failed: 0,
      passed: 384,
    });
    // the diagnosis tracks the latest run, so it is empty once parity is green
    expect(store.getArtifact(migrationId, "parityDiagnosis")).toMatchObject({ dominant: null });
  });

  it("feeds mh-repair a rendered evidence bundle, not the generic stage JSON", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();
    expect(migrationId).toBe("MH-0001");

    const repairCall = gateway.calls.find((c) => c.method === "runStage" && c.agentName === "mh-repair")!;
    expect(repairCall.input).toContain("Parity evidence");
    expect(repairCall.input).toContain("fx-0001");
    expect(repairCall.input).toContain("244.08"); // the .NET golden
    expect(repairCall.input).not.toContain("hypothesis");
    expect(repairCall.input).not.toContain("DECIMAL_ROUNDING"); // diagnosis never leaks to repair
  });

  it("has gates 1-5 green after the loop settles", async () => {
    const { migrationId } = orch.start(START);
    await orch.drain();

    const gates = orch.view(migrationId)!.gates;
    const byId = Object.fromEntries(gates.map((g) => [g.id, g.status]));
    expect(byId["discovery"]).toBe("pass");
    expect(byId["contract"]).toBe("pass");
    expect(byId["rust-build"]).toBe("pass");
    expect(byId["behavioral-parity"]).toBe("pass");
    expect(byId["clippy"]).toBe("pass");
  });
});
