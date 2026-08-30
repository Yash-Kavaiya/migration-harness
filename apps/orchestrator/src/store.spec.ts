import { describe, expect, it } from "vitest";
import { advance, initialState } from "@mh/shared";
import { Store } from "./store.js";

function freshStore(): Store {
  return new Store(":memory:");
}

const AT = "2026-08-28T12:00:00.000Z";

function newMigration(store: Store, id = "MH-0001"): void {
  store.createMigration({
    id,
    sourceRepo: "acme/orderpricing-legacy",
    sourceCommit: "abc1234",
    sourcePath: "src/OrderPricing.Api",
    targetRepo: "acme/orderpricing-legacy",
    targetBranch: "migration/MH-0001",
    at: AT,
  });
}

describe("Store — migrations & state", () => {
  it("creates a migration at discover/running", () => {
    const store = freshStore();
    newMigration(store);
    const m = store.getMigration("MH-0001")!;
    expect(m.stage).toBe("discover");
    expect(m.phase).toBe("running");
    expect(m.repairRounds).toBe(0);
    store.close();
  });

  it("round-trips a state-machine snapshot including history", () => {
    const store = freshStore();
    newMigration(store);

    let state = initialState("MH-0001");
    state = advance(state, { outcome: "ok", at: AT }).state; // discover -> contract
    state = advance(state, { outcome: "ok", at: AT }).state; // contract -> migrate
    store.saveState("MH-0001", state, AT);

    const loaded = store.loadState("MH-0001")!;
    expect(loaded.stage).toBe("migrate");
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]).toMatchObject({ from: "discover", to: "contract", outcome: "ok" });
    store.close();
  });

  it("appends only new transitions on repeated saves", () => {
    const store = freshStore();
    newMigration(store);
    let state = initialState("MH-0001");

    state = advance(state, { outcome: "ok", at: AT }).state;
    store.saveState("MH-0001", state, AT);
    state = advance(state, { outcome: "ok", at: AT }).state;
    store.saveState("MH-0001", state, AT);
    store.saveState("MH-0001", state, AT); // idempotent re-save

    expect(store.loadState("MH-0001")!.history).toHaveLength(2);
    store.close();
  });
});

describe("Store — events & reconnect cursor", () => {
  it("returns only events after a given sequence", () => {
    const store = freshStore();
    newMigration(store);
    for (let i = 1; i <= 5; i++) {
      store.appendEvent("MH-0001", "sess-1", i, "tf.model.message", { i }, AT);
    }
    expect(store.events("MH-0001").length).toBe(5);
    const tail = store.events("MH-0001", 3);
    expect(tail.map((e) => e.seq)).toEqual([4, 5]);
    expect(tail[0]!.payload).toEqual({ i: 4 });
    store.close();
  });
});

describe("Store — artifacts, licenses, interactions", () => {
  it("upserts artifacts by (migration, kind)", () => {
    const store = freshStore();
    newMigration(store);
    store.putArtifact("MH-0001", "architecture", { endpoints: 2 }, AT);
    store.putArtifact("MH-0001", "architecture", { endpoints: 5 }, AT);
    expect(store.getArtifact("MH-0001", "architecture")).toEqual({ endpoints: 5 });
    expect(store.getArtifact("MH-0001", "missing")).toBeNull();
    store.close();
  });

  it("stores and reads back a license", () => {
    const store = freshStore();
    newMigration(store);
    const license = {
      licenseId: "LIC-MH-0001-01",
      migrationId: "MH-0001",
      decision: "allow" as const,
      approvedManifestSha256: "a".repeat(64),
      permittedAction: "open PR",
      target: "acme/orderpricing-legacy:migration/MH-0001",
      uses: 1,
      decidedBy: "yash.kavaiya3@gmail.com",
      decidedAt: AT,
    };
    store.putLicense(license, AT);
    expect(store.getLicense("MH-0001")).toEqual(license);
    store.close();
  });

  it("tracks a pending interaction through resolution", () => {
    const store = freshStore();
    newMigration(store);
    store.putPendingInteraction({
      eventId: "MH-0001:7",
      migrationId: "MH-0001",
      sessionId: "sess-1",
      threadId: "main",
      kind: "approval",
      payload: { toolCalls: [{ id: "tc-1" }] },
      at: AT,
    });
    expect(store.pendingInteraction("MH-0001:7")?.resolvedAt).toBeNull();
    store.resolvePendingInteraction("MH-0001:7", AT);
    expect(store.pendingInteraction("MH-0001:7")?.resolvedAt).toBe(AT);
    store.close();
  });
});
