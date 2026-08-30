import {
  advance,
  canCutover,
  clearLicense,
  evaluateGates,
  initialState,
  isTerminal,
  readyToFreeze,
  redirect as redirectState,
  STAGE_AGENT,
  type GateInputs,
  type GateResult,
  type Architecture,
  type BuildReport,
  type MigrationContract,
  type MigrationLicense,
  type MigrationManifest,
  type MigrationStage,
  type ParityReport,
  type SecurityReport,
  type StageOutcome,
} from "@mh/shared";
import type { ServerResponse } from "node:http";
import type { AgentGateway, StageEvent } from "./trueforge.js";
import { freezeManifest, currentRustTree, reverifyManifest } from "./manifest/manifest-service.js";
import { routeApproval } from "./safety/approval-router.js";
import { LicenseService } from "./safety/licenses.js";
import { Store, type StageRunRow } from "./store.js";
import { SseHub } from "./sse.js";
import { buildRepairInput } from "./stages/repair-input.js";

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

export type RetryStage = "discover" | "contract" | "migrate" | "parity" | "security";

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
  /** Orchestrator clock reading, taken once when the stage finished. */
  at: string;
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
  private readonly licenses: LicenseService;
  private resolver: StageResolver = DEFAULT_RESOLVER;
  /** In-flight stage tasks, so tests (and shutdown) can await them. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.sse = deps.sse;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.defaults = deps.defaults ?? {};
    this.licenses = new LicenseService(this.store);
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

  list(): MigrationSummary[] {
    return this.store.listMigrations().map((migration) => ({
      migrationId: migration.id,
      source: {
        repo: migration.sourceRepo,
        commit: migration.sourceCommit,
        path: migration.sourcePath,
      },
      target: { repo: migration.targetRepo, branch: migration.targetBranch },
      stage: migration.stage,
      phase: migration.phase,
      repairRounds: migration.repairRounds,
      terminal: ["complete", "halted", "denied", "failed"].includes(migration.phase),
      createdAt: migration.createdAt,
      updatedAt: migration.updatedAt,
    }));
  }

  /** Resume agent turns that were running when the orchestrator process stopped. */
  async resumeIncomplete(): Promise<void> {
    for (const migration of this.store.listMigrations()) {
      const state = this.store.loadState(migration.id);
      if (!state || isTerminal(state) || state.phase !== "running") continue;
      if (!STAGE_AGENT[state.stage]) continue;

      const run = [...this.store.stageRuns(migration.id)]
        .reverse()
        .find((candidate) => candidate.stage === state.stage);

      // Waiting turns are intentionally parked until their persisted interaction
      // is answered. A completed run can be re-resolved without rerunning the agent.
      if (run?.status === "waiting") {
        if (state.stage === "cutover") this.routeCutoverApprovals(migration.id);
        continue;
      }
      if (run?.status === "done" && run.sessionId) {
        const task = this.resolvePersistedRun(migration.id, run);
        this.track(task);
        continue;
      }
      if (run?.status === "running" && run.sessionId && run.turnId) {
        const task = this.resumeRun(migration.id, run);
        this.track(task);
        continue;
      }

      // No resumable cursor was persisted. Starting the stage again is safer than
      // inventing an outcome; stage artifacts remain authoritative and validated.
      this.schedule(migration.id, state.stage);
    }
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
      authority: authorityPanel(state.stage, this.store.getLicense(migrationId)),
      pendingInteractions: this.store.openInteractions(migrationId),
      history: state.history,
      evidence: {
        architecture: this.store.getArtifact<Architecture>(migrationId, "architecture"),
        contract: this.store.getArtifact<MigrationContract>(migrationId, "contract"),
        build: this.store.getArtifact<BuildReport>(migrationId, "build"),
        parity: this.store.getArtifact<ParityReport>(migrationId, "parity"),
        parityDiagnosis: this.store.getArtifact(migrationId, "parityDiagnosis"),
        security: this.store.getArtifact<SecurityReport>(migrationId, "security"),
        manifest: this.store.getArtifact<MigrationManifest>(migrationId, "manifest"),
        cutover: this.store.getArtifact(migrationId, "cutover"),
      },
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
    migrationId: string,
    eventId: string,
    answer:
      | { kind: "approval"; status: "allow" }
      | { kind: "approval"; status: "deny"; reason?: string | undefined }
      | { kind: "question"; content: string },
  ): { ok: boolean; reason?: string } {
    const pending = this.store.pendingInteraction(eventId);
    if (!pending) return { ok: false, reason: "no such pending interaction" };
    if (pending.migrationId !== migrationId) {
      return { ok: false, reason: "interaction does not belong to this migration" };
    }
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

    const run = this.store.stageRuns(migrationId).find((r) => r.sessionId === pending.sessionId);
    const task = this.gateway
      .reply({
        sessionId: pending.sessionId,
        turnId: run?.turnId ?? null,
        item,
        onEvent: async (e) => {
          this.recordStageEvent(
            migrationId,
            run?.stage ?? this.store.loadState(migrationId)?.stage ?? "cutover",
            run?.id ?? null,
            pending.sessionId,
            e,
          );
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
        if (result.outcome === "waiting" && run?.stage === "cutover") {
          this.routeCutoverApprovals(migrationId);
        }
        if (result.outcome === "completed" && run) {
          return this.resolver({
            stage: run.stage,
            gateway: this.gateway,
            store: this.store,
            migrationId,
            sessionId: result.sessionId,
            turnId: result.turnId,
            at: this.clock(),
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
    this.track(task);
    return { ok: true };
  }

  /**
   * Record a human licensing decision on the frozen manifest.
   *
   * `allow` re-verifies the manifest (integrity + Rust tree unchanged), mints a
   * single-use license nonce against `manifestSha256`, advances to `cutover`, and
   * schedules it. A failed re-verification is reported and the migration stays at
   * `license` — nothing is minted. `deny` records the denial and ends the run.
   */
  decideLicense(
    migrationId: string,
    decision:
      | { decision: "allow"; decidedBy: string; reason?: string | undefined }
      | { decision: "deny"; decidedBy: string; reason?: string | undefined },
  ): { ok: boolean; reason?: string; licenseId?: string } {
    const at = this.clock();
    const state = this.store.loadState(migrationId);
    if (!state) return { ok: false, reason: "no such migration" };
    if (state.stage !== "license") return { ok: false, reason: `not awaiting a license (stage: ${state.stage})` };

    const migration = this.store.getMigration(migrationId)!;

    if (decision.decision === "deny") {
      this.licenses.recordDenial(migrationId, decision.decidedBy, decision.reason ?? "denied", at);
      const res = advance(state, { outcome: "deny", at });
      if (!res.ok) return { ok: false, ...(res.reason ? { reason: res.reason } : {}) };
      this.store.saveState(migrationId, res.state, at);
      this.relay(migrationId, "license.denied", { by: decision.decidedBy, reason: decision.reason ?? null });
      this.relay(migrationId, "state", this.snapshot(migrationId));
      return { ok: true };
    }

    const check = reverifyManifest(this.store, migrationId);
    if (!check.ok) {
      this.relay(migrationId, "license.blocked", { reason: check.reason ?? null });
      return { ok: false, reason: check.reason ?? "manifest re-verification failed" };
    }

    const manifest = this.store.getArtifact<MigrationManifest>(migrationId, "manifest")!;
    const license = this.licenses.mint({
      migrationId,
      manifest,
      decidedBy: decision.decidedBy,
      permittedAction: `open PR on ${migration.targetRepo}`,
      target: `${migration.targetRepo}:${migration.targetBranch}`,
      at,
      reason: decision.reason,
    });

    const res = advance(state, { outcome: "allow", at, licenseId: license.licenseId });
    if (!res.ok) return { ok: false, ...(res.reason ? { reason: res.reason } : {}) };

    this.store.saveState(migrationId, res.state, at);
    this.relay(migrationId, "license.granted", {
      licenseId: license.licenseId,
      by: decision.decidedBy,
      manifestSha256: manifest.manifestSha256,
    });
    this.relay(migrationId, "state", this.snapshot(migrationId));
    if (res.state.stage === "cutover") this.schedule(migrationId, "cutover");
    return { ok: true, licenseId: license.licenseId };
  }

  retryBlocked(
    migrationId: string,
    stage: RetryStage,
  ): { ok: boolean; reason?: string } {
    const at = this.clock();
    const state = this.store.loadState(migrationId);
    if (!state) return { ok: false, reason: "no such migration" };
    if (state.phase !== "blocked") {
      return { ok: false, reason: `migration is not blocked (phase: ${state.phase})` };
    }

    const result = redirectState(state, stage, at);
    if (!result.ok) return { ok: false, reason: result.reason ?? "redirect failed" };
    this.store.saveState(migrationId, result.state, at);
    this.relay(migrationId, "migration.retried", { stage });
    this.relay(migrationId, "state", this.snapshot(migrationId));
    this.schedule(migrationId, stage);
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

    if (ready) {
      const frozen = freezeManifest(this.store, migrationId, at);
      if (!frozen.ok) {
        this.relay(migrationId, "manifest.freeze_failed", { reason: frozen.reason ?? null });
        return { ok: false, readyToFreeze: true, reason: frozen.reason ?? "manifest freeze failed" };
      }
      this.relay(migrationId, "manifest.frozen", {
        manifestSha256: frozen.manifest!.manifestSha256,
        rustTreeSha256: frozen.manifest!.rustTreeSha256,
      });
    }

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
    this.track(task);
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
      this.recordStageEvent(migrationId, stage, runId, sessionId || null, e);
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
      // A GitHub-write approval during cutover is answered by the license, not by
      // parking it for a human — unless the license is missing or the tree drifted.
      if (stage === "cutover") this.routeCutoverApprovals(migrationId);
      return;
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
      at: this.clock(),
    });
    this.applyOutcome(migrationId, outcome);
  }

  /**
   * Decide every open cutover approval with the license. `allow` is answered
   * automatically (the human already authorized this by granting the license);
   * anything else is surfaced as `license.required` / `cutover.denied` and left
   * parked for a human — nothing is written.
   */
  private routeCutoverApprovals(migrationId: string): void {
    const state = this.store.loadState(migrationId);
    if (!state || state.stage !== "cutover") return;

    const manifest = this.store.getArtifact<MigrationManifest>(migrationId, "manifest");
    const license = this.store.getLicense(migrationId);
    const tree = currentRustTree(this.store, migrationId);

    for (const interaction of this.store.openInteractions(migrationId)) {
      if (interaction.kind !== "approval") continue;
      const toolCalls =
        (interaction.payload as { toolCalls?: Array<{ id?: string; name?: string }> }).toolCalls ?? [];
      const decision = routeApproval({ toolCalls }, { license, manifest, currentRustTree: tree });

      if (decision.action === "allow") {
        if (decision.toolName === "create_pull_request") {
          const approvedAt = this.clock();
          this.store.putArtifact(
            migrationId,
            "cutover",
            {
              status: "approved",
              tool: decision.toolName,
              toolCallId: decision.toolCallId,
              approvedAt,
            },
            approvedAt,
          );
        }
        this.relay(migrationId, "license.exercised", {
          licenseId: license?.licenseId ?? null,
          tool: decision.toolName,
        });
        this.answerInteraction(migrationId, interaction.eventId, { kind: "approval", status: "allow" });
        continue;
      }

      if (decision.action === "deny") {
        this.relay(migrationId, "cutover.denied", { tool: decision.toolName, reason: decision.reason });
        continue;
      }

      // park — no usable license, or the Rust tree drifted after approval.
      if (license && /TOCTOU|changed after|integrity/i.test(decision.reason)) {
        const invalidatedAt = this.clock();
        this.licenses.invalidate(license.licenseId, invalidatedAt, decision.reason);
        this.store.resolvePendingInteraction(interaction.eventId, invalidatedAt);
        const current = this.store.loadState(migrationId);
        if (current) {
          this.store.saveState(migrationId, clearLicense(current, invalidatedAt), invalidatedAt);
        }
        this.relay(migrationId, "license.invalidated", {
          licenseId: license.licenseId,
          reason: decision.reason,
        });
        this.relay(migrationId, "state", this.snapshot(migrationId));
      }
      this.relay(migrationId, "license.required", { reason: decision.reason, eventId: interaction.eventId });
    }
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

    // The license is spent the moment the PR exists — one authorization, one PR.
    if (outcome === "cutover-done" && state.licenseId) {
      this.licenses.consume(state.licenseId, at);
      this.relay(migrationId, "license.consumed", { licenseId: state.licenseId });
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

    if (stage === "repair") {
      const state = this.store.loadState(migrationId);
      const evidence = buildRepairInput(this.store, migrationId, state?.repairRounds ?? 1);
      if (evidence) return evidence;
    }

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
    const persistedSeq =
      seq ?? this.store.appendEvent(migrationId, null, null, event, data, this.clock());
    try {
      this.sse.broadcast(migrationId, { seq: persistedSeq, event, data });
    } catch {
      /* a broken SSE client or a race with shutdown must not crash a stage */
    }
  }

  private track(task: Promise<unknown>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private recordStageEvent(
    migrationId: string,
    stage: MigrationStage,
    runId: number | null,
    sessionId: string | null,
    event: StageEvent,
  ): void {
    const seq = this.store.appendEvent(
      migrationId,
      sessionId,
      event.tfSeq,
      event.type,
      event.raw,
      this.clock(),
    );
    if (runId != null && event.tfSeq != null) {
      this.store.updateStageRun(runId, { lastSeq: event.tfSeq });
    }
    this.relay(migrationId, `tf.${event.type}`, { stage, event: event.raw }, seq);

    if (event.type !== "tool.approval_required" && event.type !== "tool.response_required") return;

    const kind = event.type === "tool.approval_required" ? "approval" : "question";
    const toolCalls =
      (event.raw as { toolCalls?: Array<{ id?: string; name?: string }> }).toolCalls ?? [];
    const eventId = `${migrationId}:${event.tfSeq ?? seq}`;
    this.store.putPendingInteraction({
      eventId,
      migrationId,
      sessionId: sessionId ?? "",
      threadId: event.threadId ?? "main",
      kind,
      payload: { stage, toolCalls },
      at: this.clock(),
    });
    if (runId != null) this.store.updateStageRun(runId, { status: "waiting" });
    this.relay(migrationId, "interaction.required", { eventId, kind, stage, toolCalls });
  }

  private async resolvePersistedRun(migrationId: string, run: StageRunRow): Promise<void> {
    const outcome = await this.resolver({
      stage: run.stage,
      gateway: this.gateway,
      store: this.store,
      migrationId,
      sessionId: run.sessionId!,
      turnId: run.turnId,
      at: this.clock(),
    });
    this.applyOutcome(migrationId, outcome);
  }

  private async resumeRun(migrationId: string, run: StageRunRow): Promise<void> {
    const result = await this.gateway.resume({
      sessionId: run.sessionId!,
      turnId: run.turnId!,
      afterSequenceNumber: run.lastSeq,
      onEvent: async (event) => {
        this.recordStageEvent(migrationId, run.stage, run.id, run.sessionId, event);
      },
    });

    if (result.outcome === "waiting") {
      this.store.updateStageRun(run.id, { status: "waiting", lastSeq: result.lastSeq });
      if (run.stage === "cutover") this.routeCutoverApprovals(migrationId);
      return;
    }
    if (result.outcome === "error" || result.outcome === "cancelled") {
      this.store.updateStageRun(run.id, {
        status: "error",
        detail: result.errorDetail ?? result.outcome,
        finishedAt: this.clock(),
      });
      const state = this.store.loadState(migrationId);
      if (state && !isTerminal(state)) {
        this.store.saveState(migrationId, { ...state, phase: "failed" }, this.clock());
        this.relay(migrationId, "state", this.snapshot(migrationId));
      }
      return;
    }

    this.store.updateStageRun(run.id, {
      status: "done",
      lastSeq: result.lastSeq,
      finishedAt: this.clock(),
    });
    await this.resolvePersistedRun(migrationId, { ...run, turnId: result.turnId });
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
  evidence: {
    architecture: Architecture | null;
    contract: MigrationContract | null;
    build: BuildReport | null;
    parity: ParityReport | null;
    parityDiagnosis: unknown | null;
    security: SecurityReport | null;
    manifest: MigrationManifest | null;
    cutover: unknown | null;
  };
}

export interface MigrationSummary {
  migrationId: string;
  source: { repo: string; commit: string; path: string };
  target: { repo: string; branch: string };
  stage: MigrationStage;
  phase: string;
  repairRounds: number;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorityPanel {
  repoRead: boolean;
  sandbox: boolean;
  workspaceWrite: boolean;
  /** The Agent Authority HUD state for GitHub writes. */
  githubPush: "locked" | "licensed" | "expired";
  merge: "locked";
}

function authorityPanel(stage: MigrationStage, license: MigrationLicense | null): AuthorityPanel {
  let githubPush: AuthorityPanel["githubPush"] = "locked";
  if (license && license.decision === "allow") {
    const spent = !!license.consumedAt || !!license.invalidatedAt || license.uses < 1;
    githubPush = spent ? "expired" : "licensed";
  }
  return {
    repoRead: true,
    sandbox: stage !== "cutover" && stage !== "complete",
    workspaceWrite: ["migrate", "parity", "repair", "security"].includes(stage),
    githubPush,
    merge: "locked",
  };
}
