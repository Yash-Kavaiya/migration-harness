import type {
  AgentGateway,
  ReplyParams,
  ResumeParams,
  RunStageParams,
  StageEvent,
  StageResult,
} from "../trueforge.js";

interface Script {
  /** Events to emit before the result. */
  events?: Array<{ type: string; tfSeq?: number; threadId?: string | null; raw?: Record<string, unknown> }>;
  outcome?: StageResult["outcome"];
  /** If set, emit a tool.approval_required with this toolCallId and end as "waiting". */
  pauseForApproval?: string;
}

/**
 * A scripted stand-in for TrueForge. Each agent name maps to a Script; `reply`
 * continues from wherever `runStage` paused. Deterministic — no real I/O.
 */
export class FakeGateway implements AgentGateway {
  readonly calls: Array<{ method: string; agentName?: string; input?: string }> = [];
  private seq = 0;
  private sessionSeq = 0;
  private readonly scripts = new Map<string, Script>();
  artifacts: Record<string, string> = {};

  script(agentName: string, script: Script): this {
    this.scripts.set(agentName, script);
    return this;
  }

  async runStage(params: RunStageParams): Promise<StageResult> {
    this.calls.push({ method: "runStage", agentName: params.agentName, input: params.input });
    const sessionId = `sess-${++this.sessionSeq}`;
    const turnId = `turn-${this.sessionSeq}`;
    const script = this.scripts.get(params.agentName) ?? {};
    params.onStart?.({ sessionId });

    await this.emit(params.onEvent, {
      type: "turn.created",
      tfSeq: ++this.seq,
      threadId: null,
      raw: { type: "turn.created", turnId, state: { status: "running" } },
    });

    for (const e of script.events ?? []) {
      await this.emit(params.onEvent, {
        type: e.type,
        tfSeq: ++this.seq,
        threadId: e.threadId ?? null,
        raw: e.raw ?? { type: e.type },
      });
    }

    if (script.pauseForApproval) {
      await this.emit(params.onEvent, {
        type: "tool.approval_required",
        tfSeq: ++this.seq,
        threadId: "main",
        raw: {
          type: "tool.approval_required",
          threadId: "main",
          toolCalls: [{ id: script.pauseForApproval, name: "create_pull_request" }],
        },
      });
      return { sessionId, turnId, lastSeq: this.seq, outcome: "waiting" };
    }

    await this.emit(params.onEvent, {
      type: "turn.done",
      tfSeq: ++this.seq,
      threadId: null,
      raw: { type: "turn.done", state: { status: "done" } },
    });
    return { sessionId, turnId, lastSeq: this.seq, outcome: script.outcome ?? "completed" };
  }

  async resume(params: ResumeParams): Promise<StageResult> {
    this.calls.push({ method: "resume" });
    await this.emit(params.onEvent, {
      type: "turn.done",
      tfSeq: ++this.seq,
      threadId: null,
      raw: { type: "turn.done", state: { status: "done" } },
    });
    return { sessionId: params.sessionId, turnId: params.turnId, lastSeq: this.seq, outcome: "completed" };
  }

  async reply(params: ReplyParams): Promise<StageResult> {
    this.calls.push({ method: "reply" });
    await this.emit(params.onEvent, {
      type: "tool.response",
      tfSeq: ++this.seq,
      threadId: "main",
      raw: { type: "tool.response", content: "ok" },
    });
    await this.emit(params.onEvent, {
      type: "turn.done",
      tfSeq: ++this.seq,
      threadId: null,
      raw: { type: "turn.done", state: { status: "done" } },
    });
    return {
      sessionId: params.sessionId,
      turnId: params.turnId,
      lastSeq: this.seq,
      outcome: "completed",
    };
  }

  async downloadArtifact(params: { sessionId: string; turnId: string; path: string }): Promise<string> {
    this.calls.push({ method: "downloadArtifact", input: params.path });
    return this.artifacts[params.path] ?? "{}";
  }

  private async emit(
    onEvent: RunStageParams["onEvent"],
    e: { type: string; tfSeq: number; threadId: string | null; raw: Record<string, unknown> },
  ): Promise<void> {
    const event: StageEvent = {
      tfSeq: e.tfSeq,
      type: e.type,
      threadId: e.threadId,
      raw: e.raw as StageEvent["raw"],
    };
    await onEvent(event);
  }
}
