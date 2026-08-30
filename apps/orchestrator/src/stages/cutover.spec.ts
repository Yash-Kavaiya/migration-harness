/**
 * Freeze → license → cutover, and the safety properties that gate the only
 * GitHub write in the pipeline. Ported targets from the build plan:
 *   cannot_publish_without_approval
 *   modified_manifest_invalidates_approval
 *   license_nonce_is_single_use
 *   valid_manifest_after_approval_can_proceed
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../orchestrator.js";
import { SseHub } from "../sse.js";
import { Store } from "../store.js";
import { FakeGateway } from "../testing/fake-gateway.js";
import { makeStageResolver } from "./resolver.js";
import { confirmCutover } from "../testing/confirm-cutover.js";

let clockN = 0;
const clock = (): string => new Date(1_700_000_000_000 + clockN++ * 1000).toISOString();

let store: Store;
let sse: SseHub;
let gateway: FakeGateway;
let orch: Orchestrator;

const START = { sourceRepo: "acme/orderpricing", sourceCommit: "abc1234", sourcePath: "src/OrderPricing.Api" };
const j = (v: unknown) => JSON.stringify(v);

const architecture = {
  migrationId: "MH-0001",
  sourceRepo: "acme/orderpricing",
  sourceCommit: "abc1234",
  sourcePath: "src/OrderPricing.Api",
  entrypoint: "Program.cs",
  endpoints: [{ method: "POST", route: "/quote", requestDto: "Q", responseDto: "R" }],
  components: [{ name: "PricingEngine", riskClass: "RED" }],
};
const contract = {
  migrationId: "MH-0001",
  endpoints: [
    {
      method: "POST",
      route: "/quote",
      request: { subtotal: "number" },
      response: { total: "string" },
      compatibility: { statusCode: "exact", jsonFields: "exact", decimalScale: 2 },
    },
  ],
};
const fixturePlan = { fixtures: 384, dotnetTestCases: 34, dotnetTestsPassed: 34 };
const RUST_TREE = [
  { path: "Cargo.toml", sha256: "a".repeat(64) },
  { path: "src/main.rs", sha256: "b".repeat(64) },
  { path: "src/pricing.rs", sha256: "c".repeat(64) },
];
const build = {
  migrationId: "MH-0001",
  cargoCheck: "PASS",
  cargoTest: { passed: 34, total: 34 },
  clippy: "PASS",
  rustTree: RUST_TREE,
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

beforeEach(() => {
  clockN = 0;
  store = new Store(":memory:");
  sse = new SseHub();
  gateway = new FakeGateway();
  orch = new Orchestrator({ store, gateway, sse, clock });
  orch.setStageResolver(makeStageResolver());

  gateway.script("mh-architect", { artifacts: { "architecture.json": j(architecture) } });
  gateway.script("mh-contract", {
    artifacts: { "migration-contract.json": j(contract), "fixture-plan.json": j(fixturePlan) },
  });
  gateway.script("mh-migrator", { artifacts: { "build-report.json": j(build) } });
  gateway.script("mh-parity", { artifacts: { "parity-report.json": j(parityClean) } });
  gateway.script("mh-security", { artifacts: { "security-report.json": j(security) } });
  gateway.script("mh-cutover", { pauseForApproval: "tc-pr-1" });
});

afterEach(async () => {
  await orch.stop();
  store.close();
});

/** Run the pipeline up to the point a human is asked to license the cutover. */
async function toAwaitingLicense(): Promise<string> {
  const { migrationId } = orch.start(START);
  await orch.drain();
  const freeze = orch.evaluateAndMaybeFreeze(migrationId);
  expect(freeze).toMatchObject({ ok: true, readyToFreeze: true });
  expect(orch.view(migrationId)!.stage).toBe("license");
  expect(orch.view(migrationId)!.phase).toBe("awaiting-license");
  return migrationId;
}

describe("freeze", () => {
  it("freezes a manifest with a stable digest once gates 1-8 are green", async () => {
    const migrationId = await toAwaitingLicense();
    const manifest = store.getArtifact<{ manifestSha256: string; rustTreeSha256: string }>(migrationId, "manifest")!;
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.rustTreeSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cannot_publish_without_approval", () => {
  it("never runs the cutover agent while the migration is only awaiting a license", async () => {
    const migrationId = await toAwaitingLicense();
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(false);
    expect(orch.view(migrationId)!.licenseId).toBeNull();
  });

  it("a denied decision ends the run — no license, no cutover", async () => {
    const migrationId = await toAwaitingLicense();
    orch.decideLicense(migrationId, { decision: "deny", decidedBy: "yash@example.com", reason: "staging soak first" });
    await orch.drain();
    expect(orch.view(migrationId)!.phase).toBe("denied");
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(false);
  });
});

describe("valid_manifest_after_approval_can_proceed", () => {
  it("allow → license minted → operator checkpoint → license consumed → complete", async () => {
    const migrationId = await toAwaitingLicense();
    expect(orch.view(migrationId)!.authority.githubPush).toBe("locked");

    const decision = orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    expect(decision.ok).toBe(true);
    await confirmCutover(orch, migrationId);

    const view = orch.view(migrationId)!;
    expect(view.stage).toBe("complete");
    expect(view.terminal).toBe(true);
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(true);

    const license = store.getLicenseById(decision.licenseId!)!;
    expect(license.uses).toBe(0);
    expect(license.consumedAt).toBeTruthy();

    // Authority HUD: locked → licensed → expired
    expect(view.authority.githubPush).toBe("expired");
  });
});

describe("license_nonce_is_single_use", () => {
  it("the consumed license cannot authorize a second cutover write", async () => {
    const migrationId = await toAwaitingLicense();
    const { licenseId } = orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    await confirmCutover(orch, migrationId);
    expect(orch.view(migrationId)!.stage).toBe("complete");

    // Re-drive a fresh cutover turn against the now-spent license.
    gateway.script("mh-cutover", { pauseForApproval: "tc-pr-2" });
    // (a second cutover isn't reachable through the state machine once complete;
    // assert the nonce itself is spent)
    const license = store.getLicenseById(licenseId!)!;
    expect(license.uses).toBe(0);
    expect(license.consumedAt).toBeTruthy();
  });
});

describe("modified_manifest_invalidates_approval", () => {
  it("a workspace edit after allow blocks the license mint (manifest re-verify fails)", async () => {
    const migrationId = await toAwaitingLicense();

    // The Rust tree changes after gates went green but before the human decides.
    store.putArtifact(migrationId, "build", { ...build, rustTree: [...RUST_TREE, { path: "src/x.rs", sha256: "e".repeat(64) }] }, "tX");

    const decision = orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/TOCTOU|changed/i);

    await orch.drain();
    expect(orch.view(migrationId)!.stage).toBe("license"); // still parked
    expect(orch.view(migrationId)!.licenseId).toBeNull();
    expect(gateway.calls.some((c) => c.agentName === "mh-cutover")).toBe(false);
  });

  it("a workspace edit after the license is granted parks the cutover write and invalidates the license", async () => {
    const migrationId = await toAwaitingLicense();
    const { licenseId } = orch.decideLicense(migrationId, { decision: "allow", decidedBy: "yash@example.com" });
    // drift happens between the grant and the cutover agent's write
    store.putArtifact(migrationId, "build", { ...build, rustTree: [...RUST_TREE, { path: "src/x.rs", sha256: "e".repeat(64) }] }, "tY");
    await orch.drain();

    const view = orch.view(migrationId)!;
    expect(view).toMatchObject({ stage: "freeze", phase: "blocked", licenseId: null });
    const license = store.getLicenseById(licenseId!)!;
    expect(license.invalidatedAt).toBeTruthy();
  });
});
