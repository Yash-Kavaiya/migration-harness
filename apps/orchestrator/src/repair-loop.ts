/**
 * Bounded repair loop. Port of the stop-condition machinery in
 * `cxas-harness/gauntlet/orchestrator.py` (`CallBudget`, `parse_verdict`,
 * `run_piece`), adapted to the .NET→Rust parity setting.
 *
 * The rules that matter, all asserted by `repair-loop.spec.ts`:
 *  - a cap that is only described is not a cap — {@link CallBudget} is checked;
 *  - hitting the cap is an ESCALATE, never a silent pass;
 *  - `repaired` comes only from an independent `cargo test --test parity` re-run
 *    (`RepairRoundOutcome.parityRestored`), never from `mh-repair`'s self-report;
 *  - `parseRepairVerdict` is still fail-closed, but it only feeds the next round's
 *    prompt — an unparseable verdict cannot pass or fail the loop by itself;
 *  - a round that cannot afford both its calls is never started (no half-round
 *    that edits the tree and then skips re-verification).
 */

/** One repair attempt + one parity re-run. A round costs both. */
export const CALLS_PER_ROUND = 2;

/**
 * Counts agent invocations and refuses to hand out more than the cap. A limit of
 * `0` (or missing) means unlimited — the documented default. Never overspends by
 * one: the guard is `used >= limit`, checked before the increment.
 */
export class CallBudget {
  readonly limit: number;
  used = 0;

  constructor(limit: number | null | undefined) {
    const n = Math.trunc(limit ?? 0);
    this.limit = n > 0 ? n : 0;
  }

  /** Claim one invocation. Returns `false` when the cap is already reached. */
  spend(): boolean {
    if (this.limit && this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  get exhausted(): boolean {
    return this.limit > 0 && this.used >= this.limit;
  }

  /** Calls still available; `Infinity` when unlimited. */
  get remaining(): number {
    return this.limit === 0 ? Infinity : this.limit - this.used;
  }
}

export interface RepairVerdict {
  status: "fixed" | "failed";
  /** `mh-repair`'s own category label, echoed for the timeline. Never fed back as a hint. */
  category: string;
  /** What is still wrong — passed to the next round as the top-priority fix. */
  gap: string;
}

const FAIL_CLOSED: RepairVerdict = {
  status: "failed",
  category: "UNKNOWN",
  gap: "unparseable repair response",
};

/**
 * Extract `mh-repair`'s self-reported verdict from its final message. Mirrors
 * `parse_verdict`: scan for JSON objects, take the first that states a verdict;
 * anything unparseable resolves to `failed`. An agent that cannot state that it
 * fixed the parity break has not fixed it.
 */
export function parseRepairVerdict(text: string | null | undefined): RepairVerdict {
  const candidates: string[] = [];
  const lazy = text?.match(/\{.*?\}/gs) ?? [];
  candidates.push(...lazy);
  const greedy = text?.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) candidates.push(greedy);

  for (const raw of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    const token = rec.status ?? rec.verdict ?? rec.outcome;
    if (token === undefined) continue;
    const fixed = /^(fixed|repaired|pass|passed|ok|resolved|green)$/i.test(String(token));
    return {
      status: fixed ? "fixed" : "failed",
      category: typeof rec.category === "string" ? rec.category : "UNKNOWN",
      gap: typeof rec.gap === "string" ? rec.gap : typeof rec.biggest_gap === "string" ? rec.biggest_gap : "",
    };
  }
  return { ...FAIL_CLOSED };
}

export interface RepairRoundInput {
  round: number;
  /** Empty on round 1; the previous verdict's `gap` afterwards. */
  gap: string;
}

export interface RepairRoundOutcome {
  /** `false` when the `mh-repair` turn itself failed to run (crashed, timed out). */
  ok: boolean;
  /**
   * Did the independent `cargo test --test parity` re-run pass? This — not the
   * agent's self-report — is the sole authority for a `repaired` result. Required
   * whenever `ok` is `true`.
   */
  parityRestored?: boolean;
  /** Fixtures still failing after this round's re-run, when known. */
  failed?: number;
  /** The agent's final message. Read only for the diagnosis `gap`, never for success. */
  text: string;
  /** Human-readable reason when `ok` is `false`. */
  detail?: string;
}

export interface RunRepairLoopArgs {
  maxRounds: number;
  budget: CallBudget;
  /**
   * Drives one round: apply a fix with `mh-repair`, then run `cargo test --test
   * parity` and report its result in {@link RepairRoundOutcome.parityRestored}.
   * Charged as {@link CALLS_PER_ROUND}. May reject; a thrown error is treated
   * exactly like `{ ok: false }`.
   */
  runRound: (input: RepairRoundInput) => Promise<RepairRoundOutcome>;
  /** Optional per-round callback for the event ledger. */
  onRound?: (round: RepairRoundRecord) => void;
}

export interface RepairRoundRecord {
  round: number;
  verdict: RepairVerdict;
  /** The independently verified parity result for the round, when it ran. */
  parityRestored?: boolean;
  failed?: number;
  budgetExhausted?: boolean;
  invocationFailed?: boolean;
}

export interface RepairLoopResult {
  /** `repaired` → the parity re-run already passed; `escalate` → blocked, a human decides. */
  outcome: "repaired" | "escalate";
  reason: string;
  rounds: RepairRoundRecord[];
  budget: { used: number; limit: number };
}

/**
 * Run repair rounds until parity is restored, the round cap is hit, or the shared
 * call budget can no longer afford a whole round. Never returns `repaired` on a
 * budget/round exhaustion — that path is always `escalate`.
 */
export async function runRepairLoop(args: RunRepairLoopArgs): Promise<RepairLoopResult> {
  const { budget, maxRounds, runRound, onRound } = args;
  const rounds: RepairRoundRecord[] = [];
  let verdict: RepairVerdict = { status: "failed", category: "UNKNOWN", gap: "" };

  for (let round = 1; round <= maxRounds; round++) {
    // Two calls per round. A round that cannot afford both is not started:
    // spending the repair call and then stopping leaves the Rust tree edited
    // and unverified — the worst of both.
    if (budget.limit && budget.remaining < CALLS_PER_ROUND) {
      const reason =
        `agent-call cap reached (${budget.used}/${budget.limit}); ` +
        `raise maxAgentCalls to let repair continue`;
      const record: RepairRoundRecord = {
        round,
        budgetExhausted: true,
        verdict: { ...verdict, gap: reason },
      };
      rounds.push(record);
      onRound?.(record);
      return { outcome: "escalate", reason, rounds, budget: snapshot(budget) };
    }

    budget.spend(); // the repair attempt

    let result: RepairRoundOutcome;
    try {
      result = await runRound({ round, gap: round > 1 ? verdict.gap : "" });
    } catch (err) {
      // A rejected runRound is the same as a crashed turn — never let it escape
      // the bounded loop.
      result = { ok: false, text: "", detail: err instanceof Error ? err.message : String(err) };
    }

    if (!result.ok) {
      // A crashed repair turn is a failed round, not a graded outcome — the same
      // discipline the donor applies to a crashed builder.
      verdict = {
        status: "failed",
        category: "UNKNOWN",
        gap: `repair invocation failed: ${result.detail ?? "unknown"}`,
      };
      const record: RepairRoundRecord = { round, invocationFailed: true, verdict };
      rounds.push(record);
      onRound?.(record);
      continue;
    }

    budget.spend(); // the parity re-run

    // The agent's self-report is read for its description of what is still wrong,
    // never as the success signal. Only the independent parity re-run can say
    // "repaired".
    verdict = parseRepairVerdict(result.text);
    const parityRestored = result.parityRestored === true;
    const record: RepairRoundRecord = {
      round,
      verdict,
      parityRestored,
      ...(result.failed !== undefined ? { failed: result.failed } : {}),
    };
    rounds.push(record);
    onRound?.(record);

    if (parityRestored) {
      return {
        outcome: "repaired",
        reason: `parity re-run passed after ${round} repair round${round === 1 ? "" : "s"}`,
        rounds,
        budget: snapshot(budget),
      };
    }
  }

  return {
    outcome: "escalate",
    reason: `repair exhausted ${maxRounds} round${maxRounds === 1 ? "" : "s"} without restoring parity`,
    rounds,
    budget: snapshot(budget),
  };
}

function snapshot(b: CallBudget): { used: number; limit: number } {
  return { used: b.used, limit: b.limit };
}
