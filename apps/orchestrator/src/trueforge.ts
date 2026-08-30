import { TrueForge } from "@truefoundry/trueforge-sdk";
import type { Config } from "./config.js";

/**
 * Minimal shapes for the two turn-input items we ever send back. Kept local rather
 * than imported so the orchestrator doesn't couple to the SDK's type-export layout.
 */
export interface UserToolApprovalEvent {
  type: "user.tool_approval";
  threadId: string;
  toolCallId: string;
  approval: { status: "allow" } | { status: "deny"; reason?: string };
}
export interface UserToolResponseEvent {
  type: "user.tool_response";
  threadId: string;
  toolCallId: string;
  content: string;
}

/** A streamed turn event, as delivered by the SDK. We only read a few fields. */
export interface TurnStreamingEvent {
  type: string;
  threadId?: string | null;
  turnId?: string;
  state?: { status?: string } | string;
  [key: string]: unknown;
}

export interface StageEvent {
  /** TrueForge SSE sequence number, for reconnect cursors. Null if the frame had no id. */
  tfSeq: number | null;
  type: string;
  threadId: string | null;
  raw: TurnStreamingEvent;
}

export type StageOutcomeKind = "completed" | "waiting" | "error" | "cancelled";

export interface StageResult {
  sessionId: string;
  turnId: string | null;
  lastSeq: number;
  outcome: StageOutcomeKind;
  /** Set when `outcome === "error"`. */
  errorDetail?: string;
}

export interface RunStageParams {
  agentName: string;
  input: string;
  onEvent: (e: StageEvent) => void | Promise<void>;
  /** Called as soon as the session exists, before events start flowing. */
  onStart?: (info: { sessionId: string }) => void;
  signal?: AbortSignal;
}

export interface ResumeParams {
  sessionId: string;
  turnId: string;
  afterSequenceNumber: number;
  onEvent: (e: StageEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ReplyParams {
  sessionId: string;
  turnId: string | null;
  item: UserToolApprovalEvent | UserToolResponseEvent;
  onEvent: (e: StageEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Everything the orchestrator needs from TrueForge, behind an interface so the
 * state machine and event relay can be tested without a live server.
 */
export interface AgentGateway {
  runStage(params: RunStageParams): Promise<StageResult>;
  resume(params: ResumeParams): Promise<StageResult>;
  reply(params: ReplyParams): Promise<StageResult>;
  downloadArtifact(params: { sessionId: string; turnId: string; path: string }): Promise<string>;
}

interface StreamLike {
  withMetadata(): AsyncIterable<{ data: TurnStreamingEvent; id?: string }>;
}

async function consume(
  stream: StreamLike,
  seed: { sessionId: string; turnId: string | null; lastSeq: number },
  onEvent: RunStageParams["onEvent"],
): Promise<StageResult> {
  let { turnId, lastSeq } = seed;
  let sawPending = false;
  let outcome: StageOutcomeKind = "completed";
  let errorDetail: string | undefined;

  for await (const { data: event, id } of stream.withMetadata()) {
    const tfSeq = id != null && id !== "" ? Number(id) : null;
    if (tfSeq != null && Number.isFinite(tfSeq)) lastSeq = tfSeq;

    const threadId = typeof event.threadId === "string" ? event.threadId : null;

    if (event.type === "turn.created") {
      if (typeof event.turnId === "string") turnId = event.turnId;
    } else if (event.type === "tool.approval_required" || event.type === "tool.response_required") {
      sawPending = true;
    } else if (event.type === "turn.done") {
      const status = typeof event.state === "object" ? event.state?.status : event.state;
      if (status === "error") {
        outcome = "error";
        errorDetail = JSON.stringify(event.state);
      } else if (status === "cancelled") {
        outcome = "cancelled";
      } else {
        outcome = "completed";
      }
    }

    await onEvent({ tfSeq, type: event.type, threadId, raw: event });
  }

  // Stream ended without a terminal turn.done but with a pending interaction:
  // the turn is suspended waiting on the human.
  if (sawPending && outcome === "completed") outcome = "waiting";

  return { sessionId: seed.sessionId, turnId, lastSeq, outcome, ...(errorDetail ? { errorDetail } : {}) };
}

export class TrueForgeGateway implements AgentGateway {
  private readonly client: TrueForge;

  constructor(config: Pick<Config, "TRUEFORGE_BASE_URL" | "TRUEFORGE_API_KEY">) {
    this.client = new TrueForge(
      config.TRUEFORGE_API_KEY
        ? { baseUrl: config.TRUEFORGE_BASE_URL, token: config.TRUEFORGE_API_KEY }
        : { baseUrl: config.TRUEFORGE_BASE_URL },
    );
  }

  async runStage(params: RunStageParams): Promise<StageResult> {
    const { data: session } = await this.client.sessions.create({ agent: { name: params.agentName } });
    params.onStart?.({ sessionId: session.id });
    const stream = (await this.client.sessions.createTurnStream(
      session.id,
      { input: [{ type: "user.message", content: params.input }] },
      params.signal ? { abortSignal: params.signal } : undefined,
    )) as unknown as StreamLike;
    return consume(stream, { sessionId: session.id, turnId: null, lastSeq: 0 }, params.onEvent);
  }

  async resume(params: ResumeParams): Promise<StageResult> {
    const { data: turn } = await this.client.sessions.getTurn(params.sessionId, params.turnId);
    const running = (turn.state as { status?: string }).status === "running";

    if (running) {
      const stream = (await this.client.sessions.subscribeToTurn(params.sessionId, params.turnId, {
        afterSequenceNumber: params.afterSequenceNumber,
      })) as unknown as StreamLike;
      return consume(
        stream,
        { sessionId: params.sessionId, turnId: params.turnId, lastSeq: params.afterSequenceNumber },
        params.onEvent,
      );
    }

    // Turn already finished while we were away — replay what we missed.
    let lastSeq = params.afterSequenceNumber;
    const page = await this.client.sessions.listTurnEvents(params.sessionId, params.turnId, {
      order: "asc",
    });
    for await (const event of page) {
      const e = event as unknown as { id?: string; type: string; threadId?: string | null };
      const tfSeq = e.id != null ? Number(e.id) : null;
      if (tfSeq != null && Number.isFinite(tfSeq)) {
        if (tfSeq <= params.afterSequenceNumber) continue;
        lastSeq = tfSeq;
      }
      await params.onEvent({
        tfSeq,
        type: e.type,
        threadId: e.threadId ?? null,
        raw: event as unknown as TurnStreamingEvent,
      });
    }
    return { sessionId: params.sessionId, turnId: params.turnId, lastSeq, outcome: "completed" };
  }

  async reply(params: ReplyParams): Promise<StageResult> {
    const stream = (await this.client.sessions.createTurnStream(params.sessionId, {
      input: [params.item],
      ...(params.turnId ? { previousTurnId: params.turnId } : {}),
    })) as unknown as StreamLike;
    return consume(stream, { sessionId: params.sessionId, turnId: params.turnId, lastSeq: 0 }, params.onEvent);
  }

  async downloadArtifact(params: { sessionId: string; turnId: string; path: string }): Promise<string> {
    const res = await this.client.sessions.downloadSandboxFile(params.sessionId, params.turnId, {
      path: params.path,
    });
    // BinaryResponse — normalize to text.
    const anyRes = res as unknown as {
      text?: () => Promise<string>;
      body?: unknown;
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    if (typeof anyRes.text === "function") return anyRes.text();
    if (typeof anyRes.arrayBuffer === "function") {
      return Buffer.from(await anyRes.arrayBuffer()).toString("utf8");
    }
    return String(anyRes.body ?? "");
  }
}
