import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store.js";
import { FakeGateway } from "../testing/fake-gateway.js";
import { makeStageResolver } from "./resolver.js";
import type { MigrationStage } from "@mh/shared";

const MID = "MH-0001";
let store: Store;
let gateway: FakeGateway;
const resolver = makeStageResolver();

beforeEach(() => {
  store = new Store(":memory:");
  store.createMigration({
    id: MID,
    sourceRepo: "acme/legacy",
    sourceCommit: "abc1234",
    sourcePath: "src/Api",
    targetRepo: "acme/legacy",
    targetBranch: "mh/MH-0001",
    at: "t0",
  });
  gateway = new FakeGateway();
});
afterEach(() => store.close());

/** Put `content` where the resolver for `stage` will look, then run it. */
async function run(stage: MigrationStage, artifactName: string, content: unknown): Promise<string> {
  gateway.artifacts[artifactName] = typeof content === "string" ? content : JSON.stringify(content);
  return resolver({
    stage,
    gateway,
    store,
    migrationId: MID,
    sessionId: "sess-1",
    turnId: "turn-1",
    at: "t1",
  });
}

const ARCH = {
  migrationId: MID,
  sourceRepo: "acme/legacy",
  sourceCommit: "abc1234",
  sourcePath: "src/Api",
  entrypoint: "Program.cs",
  endpoints: [{ method: "GET", route: "/health" }],
  components: [{ name: "PricingEngine", riskClass: "RED" as const }],
};

describe("discover resolver", () => {
  it("validates architecture.json, stores it, and advances", async () => {
    expect(await run("discover", "architecture.json", ARCH)).toBe("ok");
    expect(store.getArtifact(MID, "architecture")).toMatchObject({ migrationId: MID });
  });

  it("halts when the source has an unsupported component", async () => {
    const out = await run("discover", "architecture.json", {
      ...ARCH,
      unsupported: [{ component: "SignalR hub", reason: "no websockets" }],
    });
    expect(out).toBe("unsupported");
  });

  it("throws (fails the stage) on a malformed artifact", async () => {
    await expect(run("discover", "architecture.json", "not json at all")).rejects.toThrow(/discover/);
  });

  it("throws on a schema-invalid artifact", async () => {
    await expect(run("discover", "architecture.json", { migrationId: MID })).rejects.toThrow(/schema/);
  });

  it("rejects an artifact whose embedded migrationId is for another migration", async () => {
    await expect(run("discover", "architecture.json", { ...ARCH, migrationId: "MH-9999" })).rejects.toThrow(/MH-9999/);
  });
});

describe("migrate resolver", () => {
  const build = (over: Record<string, unknown> = {}) => ({
    migrationId: MID,
    cargoCheck: "PASS",
    cargoTest: { passed: 34, total: 34 },
    clippy: "PASS",
    rustTree: [{ path: "Cargo.toml", sha256: "a".repeat(64) }],
    ...over,
  });

  it("advances when the build is green", async () => {
    expect(await run("migrate", "build-report.json", build())).toBe("ok");
    expect(store.getArtifact(MID, "build")).toMatchObject({ cargoCheck: "PASS" });
  });

  it("routes to repair when cargo check fails", async () => {
    expect(await run("migrate", "build-report.json", build({ cargoCheck: "FAIL" }))).toBe("build-failed");
  });

  it("routes to repair when tests fail", async () => {
    expect(await run("migrate", "build-report.json", build({ cargoTest: { passed: 30, total: 34 } }))).toBe("build-failed");
  });

  it("recovers a malformed build report into a bounded repair round (not a hard fail)", async () => {
    expect(await run("migrate", "build-report.json", "cargo blew up, no json")).toBe("build-failed");
    expect(store.getArtifact(MID, "buildFailure")).toMatchObject({ detail: expect.stringMatching(/not valid JSON/) });
  });
});

describe("parity resolver", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    migrationId: MID,
    total: 384,
    passed: 384,
    failed: 0,
    byRoute: [{ method: "POST", route: "/quote", passed: 384, total: 384 }],
    mismatches: [],
    ...over,
  });

  it("advances on a clean run", async () => {
    expect(await run("parity", "parity-report.json", report())).toBe("ok");
  });

  it("routes to repair on any mismatch and reconciles the counts up", async () => {
    const withTrap = report({
      passed: 384,
      failed: 0, // agent under-reported the headline number...
      mismatches: [
        {
          fixtureId: "fx-0007",
          endpoint: { method: "POST", route: "/quote" },
          input: { body: { subtotal: 249.95 } },
          dotnet: { total: "244.08" },
          rust: { total: "244.07" },
          diff: [{ path: "total", expected: "244.08", actual: "244.07" }],
        },
      ],
    });
    expect(await run("parity", "parity-report.json", withTrap)).toBe("mismatch");
    const stored = store.getArtifact<{ failed: number; passed: number; byRoute: Array<{ passed: number }> }>(MID, "parity")!;
    expect(stored).toMatchObject({ failed: 1, passed: 383 });
    expect(stored.byRoute[0]!.passed).toBe(383); // recomputed from the mismatch attribution
    expect(store.getArtifact(MID, "parityDiagnosis")).toMatchObject({ dominant: "DECIMAL_ROUNDING" });
  });

  it("rejects a report whose passed + failed does not equal total (no manufactured pass)", async () => {
    await expect(
      run("parity", "parity-report.json", report({ passed: 0, failed: 0, total: 384, mismatches: [], byRoute: [] })),
    ).rejects.toThrow(/inconsistent totals/);
  });

  it("recovers an unparseable parity report into a repair round", async () => {
    expect(await run("parity", "parity-report.json", "the parity test runner crashed")).toBe("mismatch");
    expect(store.getArtifact(MID, "parityFailure")).toBeTruthy();
  });
});

describe("repair resolver", () => {
  it("sends the migration back through parity when the log says resolved", async () => {
    expect(await run("repair", "repair-log.json", { status: "resolved", category: "DECIMAL_ROUNDING" })).toBe("repaired");
  });

  it("escalates when the agent gave up", async () => {
    expect(await run("repair", "repair-log.json", { status: "escalate" })).toBe("escalate");
  });

  it("fails closed to a bounded retry on a garbled log", async () => {
    expect(await run("repair", "repair-log.json", "the sandbox died")).toBe("build-failed");
    expect(store.getArtifact(MID, "repairLog")).toMatchObject({ status: "unparseable" });
  });

  it("fails closed to a bounded retry when the log states no status", async () => {
    expect(await run("repair", "repair-log.json", { note: "changed pricing.rs" })).toBe("build-failed");
  });
});

describe("cutover resolver", () => {
  it("fails closed when the turn completes without an approved create_pull_request call", async () => {
    await expect(run("cutover", "unused.json", {})).rejects.toThrow(/create_pull_request/i);
  });

  it("completes only after the licensed create_pull_request approval was exercised", async () => {
    store.putArtifact(
      MID,
      "cutover",
      { status: "approved", tool: "create_pull_request", toolCallId: "tc-pr-1", approvedAt: "t1" },
      "t1",
    );
    expect(await run("cutover", "unused.json", {})).toBe("cutover-done");
  });
});
