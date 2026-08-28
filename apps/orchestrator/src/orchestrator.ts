import {
  advance,
  canCutover,
  evaluateGates,
  initialState,
  isTerminal,
  readyToFreeze,
  STAGE_AGENT,
  type GateInputs,
  type GateResult,
  type MigrationStage,
  type StageOutcome,
} from "@mh/shared";
import type { ServerResponse } from "node:http";
import type { AgentGateway, StageEvent } from "./trueforge.js";
import { Store } from "./store.js";
import { SseHub } from "./sse.js";

export type Clock = () => string;

export interface OrchestratorDeps {
  store: Store;
  gateway: AgentGateway;
  sse: SseHub;
  clock?: Clock;
  /** Defaults for fields a start request omits. */
  defaults?: {
    sourceRepo?: string | undefined;
    sourcePath?: string | undefined;
    targetRepo?: string | undefined;
    targetBranch?: string | undefined;
  };
}

export interface StartMigrationInput {
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  targetRepo?: string | undefined;
  targetBranch?: string | undefined;
}

/**
 * Maps a finished stage to a state-machine outcome. Stage-specific artifact
 * handling (download, schema-validate, diagnose) is layered in on top of this in
 * later PRs; the core loop only needs the outcome token.
 */
export type StageResolver = (args: {
  stage: MigrationStage;
  gateway: AgentGateway;
  store: Store;
  migrationId: string;
  sessionId: string;
  turnId: string | null;
}) => Promise<StageOutcome>;

const DEFAULT_RESOLVER: StageResolver = async ({ stage }) => {
  // Happy-path default: every stage advances. Overridden per-stage in PR#6+.
  switch (stage) {
    case "discover":
    case "contract":
    case "migrate":
    case "parity":
    case "security":
      return "ok";
    case "repair":
      return "repaired";
    case "cutover":
      return "cutover-done";
    default:
      return "ok";
  }
};

export class Orchestrator {
  private readonly store: Store;
  private readonly gateway: AgentGateway;
  private readonly sse: SseHub;
  private readonly clock: Clock;
  private readonly defaults: NonNullable<OrchestratorDeps["defaults"]>;
  private resolver: StageResolver = DEFAULT_RESOLVER;
  /** Per-migration relay sequence for the SSE stream. */
  private readonly seqByMigration = new Map<string, number>();
  /** In-flight stage tasks, so tests (and shutdown) can await them. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.sse = deps.sse;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.defaults = deps.defaults ?? {};
  }

  setStageResolver(resolver: StageResolver): void {
    this.resolver = resolver;
  }

  /** Await every stage task currently running — for tests and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Stop scheduling new work and wait for what's running. Call before closing the store. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }

  start(input: StartMigrationInput): { migrationId: string } {
    const at = this.clock();
    const id = this.nextMigrationId();
    this.store.createMigration({
      id,
      sourceRepo: input.sourceRepo,
      sourceCommit: input.sourceCommit,
      sourcePath: input.sourcePath,
      targetRepo: input.targetRepo ?? this.defaults.targetRepo ?? input.sourceRepo,
      targetBranch: input.targetBranch ?? this.defaults.targetBranch ?? "main",
      at,
    });
    this.store.saveState(id, initialState(id), at);
    this.schedule(id, "discover");
    return { migrationId: id };
  }

  view(migrationId: string): MigrationView | null {
    const m = this.store.getMigration(migrationId);
    if (!m) return null;
    const state = this.store.loadState(migrationId)!;
    const gateInputs = this.gateInputs(migrationId);
    const gates = evaluateGates(gateInputs);
    return {
      migrationId,
      source: { repo: m.sourceRepo, commit: m.sourceCommit, path: m.sourcePath },
      target: { repo: m.targetRepo, branch: m.targetBranch },
      stage: state.stage,
      phase: state.phase,
      repairRounds: state.repairRounds,
      terminal: isTerminal(state),
      licenseId: state.licenseId,
      stages: this.store.stageRuns(migrationId),
      gates,
      readyToFreeze: readyToFreeze(gates),
      canCutover: canCutover(gates),
      authority: authorityPanel(state.stage),
      pendingInteractions: this.store.openInteractions(migrationId),
      history: state.history,
    };
  }

  events(migrationId: string, afterSeq: number): ReturnType<Store["events"]> {
    return this.store.events(migrationId, afterSeq);
  }

  /** Attach a raw HTTP response to this migration's live event stream. */
  attachStream(migrationId: string, res: ServerResponse): () => void {
    return this.sse.subscribe(migrationId, res);
  }

  /**
   * Answer a pending tool approval or question. Resumes the suspended stage by
   * feeding the decision back into the same session and continuing to consume.
   */
  answerInteraction(
    eventId: string,
    answer:
      | { kind: "approval"; status: "allow" }
      | { kind: "approval"; status: "deny"; reason?: string | undefined }
      | { kind: "question"; content: string },
  ): { ok: boolean; reason?: string } {
    const pending = this.store.pendingInteraction(eventId);
    if (!pending) return { ok: false, reason: "no such pending interaction" };
    if (pending.resolvedAt) return { ok: false, reason: "already answered" };

    const toolCalls = (pending.payload as { toolCalls?: Array<{ id?: string }> }).toolCalls ?? [];
    const toolCallId = toolCalls[0]?.id ?? "";
    const at = this.clock();
    this.store.resolvePendingInteraction(eventId, at);

    const item =
      answer.kind === "approval"
        ? {
            type: "user.tool_approval" as const,
            threadId: pending.threadId,
            toolCallId,
            approval:
              answer.status === "allow"
                ? ({ status: "allow" } as const)
                : ({ status: "deny", ...(answer.reason ? { reason: answer.reason } : {}) } as const),
          }
        : {
            type: "user.tool_response" as const,
            threadId: pending.threadId,
            toolCallId,
            content: answer.content,
          };

    const migrationId = pending.migrationId;
    const run = this.store.stageRuns(migrationId).find((r) => r.sessionId === pending.sessionId);
    const task = this.gateway
      .reply({
        sessionId: pending.sessionId,
        turnId: run?.turnId ?? null,
        item,
        onEvent: async (e) => {
          const seq = this.store.appendEvent(migrationId, pending.sessionId, e.tfSeq, e.type, e.raw, this.clock());
          this.relay(migrationId, `tf.${e.type}`, { event: e.raw }, seq);
        },
      })
      .then((result) => {
        if (run) {
          this.store.updateStageRun(run.id, {
            status: result.outcome === "waiting" ? "waiting" : "done",
            lastSeq: result.lastSeq,
            ...(result.outcome === "waiting" ? {} : { finishedAt: this.clock() }),
          });
        }
        if (result.outcome === "completed" && run) {
          return this.resolver({
            stage: run.stage,
            gateway: this.gateway,
            store: this.store,
            migrationId,
            sessionId: result.sessionId,
            turnId: result.turnId,
          }).then((outcome) => this.applyOutcome(migrationId, outcome));
        }
        return undefined;
      })
      .catch((err: unknown) => {
        if (this.stopped) return;
        this.relay(migrationId, "stage.error", {
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return { ok: true };
  }

  /**
   * Record a human licensing decision. On `allow` this is where the state machine
   * moves past the `license` stage; the actual manifest/hash verification and the
   * cutover run are wired in PR#9.
   */
  decideLicense(
    migrationId: string,
    decision:
      | { decision: "allow"; licenseId: string }
      | { decision: "deny"; reason?: string | undefined },
  ): { ok: boolean; reason?: string } {
    const at = this.clock();
    const state = this.store.loadState(migrationId);
    if (!state) return { ok: false, reason: "no such migration" };
    if (state.stage !== "license") return { ok: false, reason: `not awaiting a license (stage: ${state.stage})` };

    const res =
      decision.decision === "allow"
        ? advance(state, { outcome: "allow", at, licenseId: decision.licenseId })
        : advance(state, { outcome: "deny", at });
    if (!res.ok) return { ok: false, ...(res.reason ? { reason: res.reason } : {}) };

    this.store.saveState(migrationId, res.state, at);
    this.relay(migrationId, "state", this.snapshot(migrationId));
    if (res.state.stage === "cutover") this.schedule(migrationId, "cutover");
    return { ok: true };
  }

  /** Orchestrator-run gate + freeze step (gates 1-8). PR#8 fills in the manifest freeze. */
  evaluateAndMaybeFreeze(migrationId: string): { ok: boolean; readyToFreeze: boolean; reason?: string } {
    const at = this.clock();
    const state = this.store.loadState(migrationId);
    if (!state) return { ok: false, readyToFreeze: false, reason: "no such migration" };
    if (state.stage !== "freeze") {
      return { ok: false, readyToFreeze: false, reason: `not at freeze (stage: ${state.stage})` };
    }
    const gates = evaluateGates(this.gateInputs(migrationId));
    const ready = readyToFreeze(gates);
    const res = advance(state, { outcome: ready ? "gates-green" : "gates-red", at });
    if (res.ok) {
      this.store.saveState(migrationId, res.state, at);
      this.relay(migrationId, "state", this.snapshot(migrationId));
    }
    return { ok: res.ok, readyToFreeze: ready, ...(res.reason ? { reason: res.reason } : {}) };
  }

  // ---- internals ---------------------------------------------------------

  private schedule(migrationId: string, stage: MigrationStage): void {
    if (this.stopped) return;
    const task = this.runStage(migrationId, stage).catch((err: unknown) => {
      if (this.stopped) return;
      const at = this.clock();
      const detail = err instanceof Error ? err.message : String(err);
      this.relay(migrationId, "stage.error", { stage, detail });
      const state = this.store.loadState(migrationId);
      if (state && !isTerminal(state)) {
        // A thrown stage is unrecoverable for the core loop.
        this.store.saveState(migrationId, { ...state, phase: "failed" }, at);
        this.relay(migrationId, "state", this.snapshot(migrationId));
      }
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private async runStage(migrationId: string, stage: MigrationStage): Promise<void> {
    const agent = STAGE_AGENT[stage];
    const runId = this.store.startStageRun(migrationId, stage, agent, this.clock());
    this.relay(migrationId, "stage.started", { stage, agent });

    if (!agent) {
      // Orchestrator-run stage (freeze / license / complete) — no session.
      this.store.updateStageRun(runId, { status: "done", finishedAt: this.clock() });
      return;
    }

    let sessionId = "";

    const onEvent = async (e: StageEvent): Promise<void> => {
      const seq = this.store.appendEvent(migrationId, sessionId || null, e.tfSeq, e.type, e.raw, this.clock());
      this.store.updateStageRun(runId, e.tfSeq != null ? { lastSeq: e.tfSeq } : {});
      this.relay(migrationId, `tf.${e.type}`, { stage, event: e.raw }, seq);

      if (e.type === "tool.approval_required" || e.type === "tool.response_required") {
        const kind = e.type === "tool.approval_required" ? "approval" : "question";
        const toolCalls = (e.raw as { toolCalls?: Array<{ id?: string; name?: string }> }).toolCalls ?? [];
        const eventId = `${migrationId}:${e.tfSeq ?? seq}`;
        this.store.putPendingInteraction({
          eventId,
          migrationId,
          sessionId,
          threadId: e.threadId ?? "main",
          kind,
          payload: { stage, toolCalls },
          at: this.clock(),
        });
        this.store.updateStageRun(runId, { status: "waiting" });
        this.relay(migrationId, "interaction.required", { eventId, kind, stage, toolCalls });
      }
    };

    const result = await this.gateway.runStage({
      agentName: agent,
      input: this.stageInput(migrationId, stage),
      onStart: ({ sessionId: sid }) => {
        sessionId = sid;
        this.store.attachSession(runId, sid, null);
      },
      onEvent,
    });
    this.store.attachSession(runId, result.sessionId, result.turnId);

    if (result.outcome === "waiting") {
      this.store.updateStageRun(runId, { status: "waiting", lastSeq: result.lastSeq });
      return; // resumed later by answerInteraction
    }
    if (result.outcome === "error" || result.outcome === "cancelled") {
      this.store.updateStageRun(runId, {
        status: "error",
        detail: result.errorDetail ?? result.outcome,
        finishedAt: this.clock(),
      });
      const state = this.store.loadState(migrationId)!;
      if (!isTerminal(state)) this.store.saveState(migrationId, { ...state, phase: "failed" }, this.clock());
      this.relay(migrationId, "state", this.snapshot(migrationId));
      return;
    }

    this.store.updateStageRun(runId, {
      status: "done",
      lastSeq: result.lastSeq,
      finishedAt: this.clock(),
    });

    const outcome = await this.resolver({
      stage,
      gateway: this.gateway,
      store: this.store,
      migrationId,
      sessionId: result.sessionId,
      turnId: result.turnId,
    });
    this.applyOutcome(migrationId, outcome);
  }

  private applyOutcome(migrationId: string, outcome: StageOutcome): void {
    if (this.stopped) return;
    const at = this.clock();
    const state = this.store.loadState(migrationId)!;
    const res = advance(state, { outcome, at });
    if (!res.ok) {
      this.relay(migrationId, "stage.error", { detail: res.reason ?? "illegal transition" });
      return;
    }
    this.store.saveState(migrationId, res.state, at);
    this.relay(migrationId, "state", this.snapshot(migrationId));

    if (isTerminal(res.state)) return;

    // Drive the next stage if it has an agent. Orchestrator/human stages
    // (freeze / license) are advanced explicitly elsewhere.
    const next = res.state.stage;
    if (STAGE_AGENT[next]) this.schedule(migrationId, next);
  }

  private gateInputs(migrationId: string): GateInputs {
    return {
      architecture: this.store.getArtifact(migrationId, "architecture"),
      contract: this.store.getArtifact(migrationId, "contract"),
      build: this.store.getArtifact(migrationId, "build"),
      parity: this.store.getArtifact(migrationId, "parity"),
      security: this.store.getArtifact(migrationId, "security"),
      sourceTests: this.store.getArtifact(migrationId, "sourceTests"),
      manifest: this.store.getArtifact(migrationId, "manifest"),
      license: this.store.getLicense(migrationId),
    };
  }

  private snapshot(migrationId: string): unknown {
    const v = this.view(migrationId);
    return v && { stage: v.stage, phase: v.phase, gates: v.gates, canCutover: v.canCutover };
  }

  private stageInput(migrationId: string, stage: MigrationStage): string {
    const m = this.store.getMigration(migrationId)!;
    return JSON.stringify({
      migrationId,
      stage,
      sourceRepo: m.sourceRepo,
      sourceCommit: m.sourceCommit,
      sourcePath: m.sourcePath,
      targetRepo: m.targetRepo,
      targetBranch: m.targetBranch,
    });
  }

  private relay(migrationId: string, event: string, data: unknown, seq?: number): void {
    if (this.stopped) return;
    try {
      const s = seq ?? this.bumpSeq(migrationId);
      this.sse.broadcast(migrationId, { seq: s, event, data });
    } catch {
      /* a broken SSE client or a race with shutdown must not crash a stage */
    }
  }

  private bumpSeq(migrationId: string): number {
    const next = (this.seqByMigration.get(migrationId) ?? 0) + 1;
    this.seqByMigration.set(migrationId, next);
    return next;
  }

  private nextMigrationId(): string {
    const count = this.store.listMigrations().length;
    return `MH-${String(count + 1).padStart(4, "0")}`;
  }
}

export interface MigrationView {
  migrationId: string;
  source: { repo: string; commit: string; path: string };
  target: { repo: string; branch: string };
  stage: MigrationStage;
  phase: string;
  repairRounds: number;
  terminal: boolean;
  licenseId: string | null;
  stages: ReturnType<Store["stageRuns"]>;
  gates: GateResult[];
  readyToFreeze: boolean;
  canCutover: boolean;
  authority: AuthorityPanel;
  pendingInteractions: ReturnType<Store["openInteractions"]>;
  history: unknown[];
}

export interface AuthorityPanel {
  repoRead: boolean;
  sandbox: boolean;
  workspaceWrite: boolean;
  githubPush: "locked" | "active";
  merge: "locked";
}

function authorityPanel(stage: MigrationStage): AuthorityPanel {
  return {
    repoRead: true,
    sandbox: stage !== "cutover" && stage !== "complete",
    workspaceWrite: ["migrate", "parity", "repair", "security"].includes(stage),
    githubPush: stage === "cutover" ? "active" : "locked",
    merge: "locked",
  };
}
