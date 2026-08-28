/**
 * Migration state machine. The orchestrator owns this; each non-human stage is one
 * TrueForge session. Transitions are driven only by a stage's recorded outcome —
 * never by the agents themselves. An agent can produce an artifact; only the
 * orchestrator moves the migration forward.
 */

export type MigrationStage =
  | "discover"
  | "contract"
  | "migrate"
  | "parity"
  | "repair"
  | "security"
  | "freeze"
  | "license"
  | "cutover"
  | "complete";

/** Pipeline order for display. `repair` is a side loop off `parity`/`migrate`. */
export const STAGE_ORDER: readonly MigrationStage[] = [
  "discover",
  "contract",
  "migrate",
  "parity",
  "security",
  "freeze",
  "license",
  "cutover",
  "complete",
] as const;

/** The agent that runs a stage, or `null` when the orchestrator or a human does. */
export const STAGE_AGENT: Record<MigrationStage, string | null> = {
  discover: "mh-architect",
  contract: "mh-contract",
  migrate: "mh-migrator",
  parity: "mh-parity",
  repair: "mh-repair",
  security: "mh-security",
  freeze: null, // orchestrator: evaluate gates 1-8, build + hash the manifest
  license: null, // human: allow / deny
  cutover: "mh-cutover",
  complete: null,
};

export type StageOutcome =
  | "ok" // stage succeeded, advance on the happy path
  | "unsupported" // discovery hit something in the UNSUPPORTED list
  | "build-failed" // migrate/repair produced code that will not compile or test
  | "mismatch" // parity found behavioral differences vs the goldens
  | "repaired" // repair applied a patch — re-verify from parity
  | "escalate" // repair exhausted its attempts for a failure class
  | "gates-green" // freeze: gates 1-8 all pass, manifest frozen
  | "gates-red" // freeze: at least one of gates 1-8 is failing
  | "allow" // human granted the license
  | "deny" // human refused the license
  | "cutover-done" // the PR was opened
  | "toctou-fail"; // the Rust tree changed after the license was granted

export type MigrationPhase =
  | "running" // an agent or the orchestrator is working
  | "blocked" // a gate is red; a human must decide what to re-run
  | "awaiting-license" // gates green, manifest frozen, waiting on a human
  | "complete" // PR opened, license consumed
  | "halted" // stopped on an unsupported component
  | "denied" // human refused the license
  | "failed"; // repair escalated, or a stage errored unrecoverably

export const TERMINAL_PHASES: readonly MigrationPhase[] = ["complete", "halted", "denied", "failed"] as const;

/** Repair gets this many rounds across the whole migration before it escalates. */
export const MAX_REPAIR_ROUNDS = 3;

export interface StageTransition {
  from: MigrationStage;
  to: MigrationStage;
  outcome: StageOutcome;
  at: string;
}

export interface MigrationState {
  migrationId: string;
  stage: MigrationStage;
  phase: MigrationPhase;
  /** Bounded by {@link MAX_REPAIR_ROUNDS}; incremented each time repair runs. */
  repairRounds: number;
  /** Set once the human decides `allow`; cleared if the license is invalidated. */
  licenseId: string | null;
  history: StageTransition[];
}

export function initialState(migrationId: string): MigrationState {
  return {
    migrationId,
    stage: "discover",
    phase: "running",
    repairRounds: 0,
    licenseId: null,
    history: [],
  };
}

export function isTerminal(state: MigrationState): boolean {
  return TERMINAL_PHASES.includes(state.phase);
}

interface Target {
  stage: MigrationStage;
  phase: MigrationPhase;
}

/** Enter repair, unless we have already spent every allowed round — then give up. */
function enterRepair(state: MigrationState): Target {
  return state.repairRounds >= MAX_REPAIR_ROUNDS
    ? { stage: "repair", phase: "failed" }
    : { stage: "repair", phase: "running" };
}

/** Pure transition table. Returns `null` if the outcome is not legal in this stage. */
function resolve(state: MigrationState, outcome: StageOutcome): Target | null {
  switch (state.stage) {
    case "discover":
      if (outcome === "ok") return { stage: "contract", phase: "running" };
      if (outcome === "unsupported") return { stage: "discover", phase: "halted" };
      return null;

    case "contract":
      if (outcome === "ok") return { stage: "migrate", phase: "running" };
      return null;

    case "migrate":
      if (outcome === "ok") return { stage: "parity", phase: "running" };
      if (outcome === "build-failed") return enterRepair(state);
      return null;

    case "parity":
      if (outcome === "ok") return { stage: "security", phase: "running" };
      if (outcome === "mismatch") return enterRepair(state);
      return null;

    case "repair":
      if (outcome === "escalate") return { stage: "repair", phase: "failed" };
      if (outcome === "repaired") return { stage: "parity", phase: "running" };
      if (outcome === "build-failed") return enterRepair(state);
      return null;

    case "security":
      // The scan always completes; gate 8 is what actually holds the line at freeze.
      if (outcome === "ok") return { stage: "freeze", phase: "running" };
      return null;

    case "freeze":
      if (outcome === "gates-green") return { stage: "license", phase: "awaiting-license" };
      if (outcome === "gates-red") return { stage: "freeze", phase: "blocked" };
      return null;

    case "license":
      if (outcome === "allow") return { stage: "cutover", phase: "running" };
      if (outcome === "deny") return { stage: "license", phase: "denied" };
      return null;

    case "cutover":
      if (outcome === "cutover-done") return { stage: "complete", phase: "complete" };
      // The tree moved under us — the license is now void; a human re-freezes.
      if (outcome === "toctou-fail") return { stage: "freeze", phase: "blocked" };
      return null;

    case "complete":
      return null;
  }
}

export interface AdvanceInput {
  outcome: StageOutcome;
  /** ISO-8601 timestamp; the caller supplies it (scripts here cannot read the clock). */
  at: string;
  /** Required when `outcome` is `allow`. */
  licenseId?: string;
}

export interface AdvanceResult {
  ok: boolean;
  state: MigrationState;
  reason?: string;
}

/**
 * Apply a stage outcome. Returns a new state (the input is never mutated) plus
 * `ok: false` and the original state if the outcome is not legal here.
 */
export function advance(state: MigrationState, input: AdvanceInput): AdvanceResult {
  if (isTerminal(state)) {
    return { ok: false, state, reason: `migration is already ${state.phase}` };
  }

  const target = resolve(state, input.outcome);
  if (!target) {
    return { ok: false, state, reason: `outcome '${input.outcome}' is not valid in stage '${state.stage}'` };
  }

  if (input.outcome === "allow" && !input.licenseId) {
    return { ok: false, state, reason: "a licenseId is required to advance past 'license'" };
  }

  const enteringRepair = target.stage === "repair" && target.phase === "running";

  let licenseId = state.licenseId;
  if (input.outcome === "allow") licenseId = input.licenseId ?? null;
  else if (input.outcome === "toctou-fail") licenseId = null; // the grant is now void

  const next: MigrationState = {
    ...state,
    stage: target.stage,
    phase: target.phase,
    repairRounds: enteringRepair ? state.repairRounds + 1 : state.repairRounds,
    licenseId,
    history: [
      ...state.history,
      { from: state.stage, to: target.stage, outcome: input.outcome, at: input.at },
    ],
  };

  return { ok: true, state: next };
}

/**
 * Orchestrator override used only after a human diagnoses a red gate: send the
 * migration back to a specific earlier stage to be re-run. Never callable by an agent.
 */
export function redirect(state: MigrationState, stage: MigrationStage, at: string): AdvanceResult {
  if (isTerminal(state)) {
    return { ok: false, state, reason: `migration is already ${state.phase}` };
  }
  if (stage === "complete") {
    return { ok: false, state, reason: "cannot redirect to 'complete'" };
  }
  return {
    ok: true,
    state: {
      ...state,
      stage,
      phase: "running",
      history: [
        ...state.history,
        { from: state.stage, to: stage, outcome: "gates-red", at },
      ],
    },
  };
}

/** Invalidating a license drops the migration back to an unlicensed, blocked state. */
export function clearLicense(state: MigrationState, at: string): MigrationState {
  return {
    ...state,
    stage: "freeze",
    phase: "blocked",
    licenseId: null,
    history: [
      ...state.history,
      { from: state.stage, to: "freeze", outcome: "toctou-fail", at },
    ],
  };
}
