import { describe, expect, it } from "vitest";
import {
  advance,
  clearLicense,
  initialState,
  isTerminal,
  MAX_REPAIR_ROUNDS,
  redirect,
  type MigrationState,
  type StageOutcome,
} from "@mh/shared/state";

const AT = "2026-08-28T12:00:00.000Z";

/** Drive a state through a sequence of outcomes, asserting each step is legal. */
function run(outcomes: Array<StageOutcome | [StageOutcome, string]>): MigrationState {
  let state = initialState("MH-0042");
  for (const step of outcomes) {
    const [outcome, licenseId] = Array.isArray(step) ? step : [step, undefined];
    const result = advance(state, { outcome, at: AT, ...(licenseId ? { licenseId } : {}) });
    expect(result.ok, `outcome '${outcome}' in stage '${state.stage}': ${result.reason ?? ""}`).toBe(true);
    state = result.state;
  }
  return state;
}

describe("initialState", () => {
  it("starts at discover / running with no repairs and no license", () => {
    const s = initialState("MH-0042");
    expect(s).toMatchObject({ stage: "discover", phase: "running", repairRounds: 0, licenseId: null });
    expect(s.history).toEqual([]);
    expect(isTerminal(s)).toBe(false);
  });
});

describe("the happy path", () => {
  it("runs discover → complete when every stage passes", () => {
    const end = run([
      "ok", // discover  -> contract
      "ok", // contract  -> migrate
      "ok", // migrate   -> parity
      "ok", // parity    -> security
      "ok", // security  -> freeze
      "gates-green", // freeze -> license
      ["allow", "LIC-MH-0042-01"], // license -> cutover
      "cutover-done", // cutover -> complete
    ]);
    expect(end.stage).toBe("complete");
    expect(end.phase).toBe("complete");
    expect(end.licenseId).toBe("LIC-MH-0042-01");
    expect(isTerminal(end)).toBe(true);
    expect(end.history).toHaveLength(8);
  });
});

describe("illegal transitions", () => {
  it("rejects an unknown outcome for the current stage without mutating state", () => {
    const s = initialState("MH-0042");
    const result = advance(s, { outcome: "cutover-done", at: AT });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not valid in stage 'discover'");
    expect(result.state).toBe(s);
  });

  it("requires a licenseId to advance past the license stage", () => {
    let state = run(["ok", "ok", "ok", "ok", "ok", "gates-green"]);
    const result = advance(state, { outcome: "allow", at: AT });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/licenseId/);
  });

  it("refuses to advance a terminal migration", () => {
    const halted = run(["unsupported"]);
    expect(halted.phase).toBe("halted");
    expect(advance(halted, { outcome: "ok", at: AT }).ok).toBe(false);
  });
});

describe("discovery halt", () => {
  it("goes terminal when the source uses an unsupported component", () => {
    const s = run(["unsupported"]);
    expect(s).toMatchObject({ stage: "discover", phase: "halted" });
    expect(isTerminal(s)).toBe(true);
  });
});

describe("the repair loop", () => {
  it("counts a round each time repair is entered, from build failures or parity mismatches", () => {
    const s = run([
      "ok", // discover
      "ok", // contract
      "build-failed", // migrate -> repair (round 1)
      "repaired", // repair -> parity
      "mismatch", // parity -> repair (round 2)
      "repaired", // repair -> parity
    ]);
    expect(s.stage).toBe("parity");
    expect(s.repairRounds).toBe(2);
  });

  it(`escalates to failed after ${MAX_REPAIR_ROUNDS} rounds are exhausted`, () => {
    const outcomes: StageOutcome[] = ["ok", "ok", "build-failed"];
    // rounds 2..MAX: repaired then mismatch back into repair
    for (let round = 2; round <= MAX_REPAIR_ROUNDS; round++) {
      outcomes.push("repaired", "mismatch");
    }
    let state = run(outcomes);
    expect(state).toMatchObject({ stage: "repair", phase: "running", repairRounds: MAX_REPAIR_ROUNDS });

    // One more failure with no rounds left -> terminal failure.
    const result = advance(state, { outcome: "repaired", at: AT });
    expect(result.ok).toBe(true);
    state = result.state;
    // repaired sends it back to parity; the next mismatch has no round left.
    const escalated = advance(state, { outcome: "mismatch", at: AT }).state;
    expect(escalated).toMatchObject({ stage: "repair", phase: "failed" });
    expect(isTerminal(escalated)).toBe(true);
  });

  it("escalates immediately on an explicit `escalate` outcome", () => {
    const s = run(["ok", "ok", "build-failed"]);
    const escalated = advance(s, { outcome: "escalate", at: AT }).state;
    expect(escalated).toMatchObject({ stage: "repair", phase: "failed" });
  });
});

describe("license outcomes", () => {
  it("goes to denied (terminal) when the human refuses", () => {
    const s = run(["ok", "ok", "ok", "ok", "ok", "gates-green", "deny"]);
    expect(s).toMatchObject({ stage: "license", phase: "denied" });
    expect(isTerminal(s)).toBe(true);
  });

  it("blocks (not terminal) when freeze finds a red gate", () => {
    const s = run(["ok", "ok", "ok", "ok", "ok", "gates-red"]);
    expect(s).toMatchObject({ stage: "freeze", phase: "blocked" });
    expect(isTerminal(s)).toBe(false);
  });
});

describe("cutover TOCTOU", () => {
  it("drops back to a blocked freeze when the tree moved after licensing", () => {
    const s = run([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "gates-green",
      ["allow", "LIC-MH-0042-01"],
      "toctou-fail",
    ]);
    expect(s).toMatchObject({ stage: "freeze", phase: "blocked" });
    expect(isTerminal(s)).toBe(false);
  });
});

describe("orchestrator overrides", () => {
  it("redirect sends a blocked migration back to an earlier stage as running", () => {
    const blocked = run(["ok", "ok", "ok", "ok", "ok", "gates-red"]);
    const back = redirect(blocked, "migrate", AT);
    expect(back.ok).toBe(true);
    expect(back.state).toMatchObject({ stage: "migrate", phase: "running" });
    expect(back.state.history.at(-1)).toMatchObject({ from: "freeze", to: "migrate" });
  });

  it("clearLicense voids the license and blocks at freeze", () => {
    const licensed = run([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "gates-green",
      ["allow", "LIC-MH-0042-01"],
    ]);
    expect(licensed.licenseId).toBe("LIC-MH-0042-01");
    const cleared = clearLicense(licensed, AT);
    expect(cleared).toMatchObject({ stage: "freeze", phase: "blocked", licenseId: null });
  });

  it("does not mutate the input state", () => {
    const s = initialState("MH-0042");
    const frozen = JSON.stringify(s);
    advance(s, { outcome: "ok", at: AT });
    redirect(s, "migrate", AT);
    clearLicense(s, AT);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
