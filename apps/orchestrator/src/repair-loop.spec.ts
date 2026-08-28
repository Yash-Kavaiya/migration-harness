import { describe, expect, it, vi } from "vitest";
import {
  CallBudget,
  parseRepairVerdict,
  runRepairLoop,
  type RepairRoundOutcome,
} from "./repair-loop.js";

// ------------------------------------------------------------------ CallBudget
// Ported from cxas-harness/gauntlet/tests/test_stop_conditions.py.

describe("CallBudget", () => {
  it("treats a zero cap as unlimited (the default for anyone who never edits config)", () => {
    const b = new CallBudget(0);
    for (let i = 0; i < 100; i++) expect(b.spend()).toBe(true);
    expect(b.exhausted).toBe(false);
  });

  it("stops handing out calls once the cap is reached", () => {
    const b = new CallBudget(3);
    expect([b.spend(), b.spend(), b.spend(), b.spend(), b.spend()]).toEqual([true, true, true, false, false]);
    expect(b.used).toBe(3);
    expect(b.exhausted).toBe(true);
  });

  it("never overspends by one (`used >= limit`, not `used > limit`)", () => {
    const b = new CallBudget(1);
    expect(b.spend()).toBe(true);
    expect(b.spend()).toBe(false);
    expect(b.used).toBe(1);
  });

  it("treats a missing cap as unlimited, not as zero-calls-allowed", () => {
    expect(new CallBudget(null).spend()).toBe(true);
    expect(new CallBudget(undefined).spend()).toBe(true);
  });
});

// ------------------------------------------------------- parseRepairVerdict
// Ported from parse_verdict: fail-closed on anything it cannot read.

describe("parseRepairVerdict", () => {
  it("reads a clean fixed verdict", () => {
    const v = parseRepairVerdict('{"status":"fixed","category":"DECIMAL_ROUNDING","gap":""}');
    expect(v).toEqual({ status: "fixed", category: "DECIMAL_ROUNDING", gap: "" });
  });

  it("reads a failed verdict and carries the gap forward", () => {
    const v = parseRepairVerdict('prose... {"status":"failed","gap":"tax still off on gold tier"} ...more');
    expect(v.status).toBe("failed");
    expect(v.gap).toBe("tax still off on gold tier");
  });

  it("accepts `verdict: PASS` phrasing too", () => {
    expect(parseRepairVerdict('{"verdict":"PASS"}').status).toBe("fixed");
  });

  it("is a failure when the response is unparseable — a non-answer is not an approval", () => {
    expect(parseRepairVerdict("I think it is probably fine now").status).toBe("failed");
    expect(parseRepairVerdict("").status).toBe("failed");
    expect(parseRepairVerdict(null).status).toBe("failed");
    expect(parseRepairVerdict('{"status":') .status).toBe("failed");
  });

  it("is a failure when JSON is present but states no verdict", () => {
    expect(parseRepairVerdict('{"note":"changed pricing.rs"}').status).toBe("failed");
  });
});

// --------------------------------------------------------- loop enforcement

/** A round runner that always reports the parity break is still open. */
const alwaysFailing = async (): Promise<RepairRoundOutcome> => ({
  ok: true,
  text: '{"status":"failed","gap":"still 6 fixtures red"}',
});

describe("runRepairLoop — stop conditions", () => {
  it("returns `repaired` as soon as a round reports fixed", async () => {
    const runRound = vi
      .fn<(i: { round: number; gap: string }) => Promise<RepairRoundOutcome>>()
      .mockResolvedValueOnce({ ok: true, text: '{"status":"failed","gap":"tax"}' })
      .mockResolvedValueOnce({ ok: true, text: '{"status":"fixed","category":"DECIMAL_ROUNDING"}' });
    const res = await runRepairLoop({ maxRounds: 6, budget: new CallBudget(0), runRound });
    expect(res.outcome).toBe("repaired");
    expect(res.rounds).toHaveLength(2);
    expect(res.budget.used).toBe(4);
    // Round 2 was told what round 1 left open.
    expect(runRound.mock.calls[1]?.[0]?.gap).toBe("tax");
  });

  it("the call cap actually stops the loop", async () => {
    const budget = new CallBudget(4);
    const res = await runRepairLoop({ maxRounds: 8, budget, runRound: alwaysFailing });
    expect(budget.used).toBe(4);
    expect(res.rounds.length).toBeLessThanOrEqual(3);
    expect(res.outcome).toBe("escalate");
  });

  it("never starts a round it cannot afford both calls for (an odd cap buys no half-round)", async () => {
    const budget = new CallBudget(3);
    await runRepairLoop({ maxRounds: 8, budget, runRound: alwaysFailing });
    expect(budget.used).toBe(2);
  });

  it("stopping on the cap is an ESCALATE, never a pass", async () => {
    const res = await runRepairLoop({ maxRounds: 8, budget: new CallBudget(2), runRound: alwaysFailing });
    expect(res.outcome).toBe("escalate");
    const stopped = res.rounds.find((r) => r.budgetExhausted);
    expect(stopped).toBeTruthy();
  });

  it("the cap message names the knob that raises it", async () => {
    const res = await runRepairLoop({ maxRounds: 8, budget: new CallBudget(2), runRound: alwaysFailing });
    const stopped = res.rounds.find((r) => r.budgetExhausted);
    expect(stopped?.verdict.gap).toContain("maxAgentCalls");
  });

  it("one budget is shared across repair sessions", async () => {
    const budget = new CallBudget(4);
    await runRepairLoop({ maxRounds: 8, budget, runRound: alwaysFailing });
    await runRepairLoop({ maxRounds: 8, budget, runRound: alwaysFailing });
    expect(budget.used).toBe(4);
  });

  it("exhausting the round cap without a fix is an ESCALATE", async () => {
    const res = await runRepairLoop({ maxRounds: 3, budget: new CallBudget(0), runRound: alwaysFailing });
    expect(res.outcome).toBe("escalate");
    expect(res.rounds).toHaveLength(3);
    expect(res.reason).toContain("3 rounds");
  });

  it("a crashed repair turn is a failed round (charged one call), not a graded outcome", async () => {
    const runRound = vi
      .fn<(i: { round: number; gap: string }) => Promise<RepairRoundOutcome>>()
      .mockResolvedValueOnce({ ok: false, text: "", detail: "sandbox OOM" })
      .mockResolvedValueOnce({ ok: true, text: '{"status":"fixed"}' });
    const budget = new CallBudget(0);
    const res = await runRepairLoop({ maxRounds: 6, budget, runRound });
    expect(res.outcome).toBe("repaired");
    expect(res.rounds[0]).toMatchObject({ invocationFailed: true });
    expect(res.rounds[0]?.verdict.gap).toContain("sandbox OOM");
    // round 1: 1 call (attempt only, no re-verify). round 2: 2 calls. => 3
    expect(budget.used).toBe(3);
  });

  it("an unparseable mh-repair verdict does not pass the loop", async () => {
    const res = await runRepairLoop({
      maxRounds: 1,
      budget: new CallBudget(0),
      runRound: async () => ({ ok: true, text: "yeah that should do it" }),
    });
    expect(res.outcome).toBe("escalate");
  });
});
