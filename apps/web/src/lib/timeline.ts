import type { TimelineEvent } from "./types";

export type TimelineKind =
  | "mcp"
  | "sandbox"
  | "approval"
  | "agent"
  | "stage"
  | "license"
  | "state"
  | "system";

export interface ClassifiedEvent {
  kind: TimelineKind;
  title: string;
  detail: string;
  simulated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedEvent(payload: unknown): Record<string, unknown> {
  const outer = asRecord(payload);
  const inner = outer.event;
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? { ...asRecord(inner), stage: outer.stage }
    : outer;
}

function toolName(payload: unknown): string {
  const rec = nestedEvent(payload);
  const calls = rec.toolCalls;
  if (Array.isArray(calls) && calls[0] && typeof calls[0] === "object") {
    const name = (calls[0] as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  if (typeof rec.name === "string") return rec.name;
  if (typeof rec.tool === "string") return rec.tool;
  return "";
}

function textContent(payload: unknown): string {
  const rec = nestedEvent(payload);
  if (typeof rec.content === "string") return rec.content;
  if (typeof rec.detail === "string") return rec.detail;
  if (typeof rec.reason === "string") return rec.reason;
  return "";
}

export function classifyTimelineEvent(event: TimelineEvent): ClassifiedEvent {
  const type = event.type.replace(/^tf\./, "");
  const rec = nestedEvent(event.payload);
  const simulated =
    rec.simulated === true ||
    (typeof rec.mode === "string" && rec.mode === "demo") ||
    type.includes("demo");
  const tool = toolName(event.payload);
  const content = textContent(event.payload);

  if (type === "tool.approval_required" || type === "interaction.required" || type === "cutover.checkpoint") {
    return {
      kind: "approval",
      title: "Tool approval required",
      detail: tool ? `${tool} is waiting for an operator checkpoint` : "GitHub write paused for approval",
      simulated,
    };
  }

  if (type === "tool.call" || type === "tool.execution" || type === "tool.result" || type === "tool.response") {
    const sandbox = /cargo|sandbox|daytona|exec/i.test(`${tool} ${content} ${JSON.stringify(rec)}`);
    const mcp = /github|mcp|get_file|list_commits|create_pull|push_files|create_branch/i.test(
      `${tool} ${content}`,
    );
    if (sandbox) {
      return {
        kind: "sandbox",
        title: type === "tool.result" || type === "tool.response" ? "Sandbox result" : "Sandbox exec",
        detail: content || tool || "isolated command",
        simulated,
      };
    }
    if (mcp) {
      return {
        kind: "mcp",
        title: /write|push|pull_request|create_branch/i.test(tool) ? "MCP github-write" : "MCP github-read",
        detail: content || tool || "repository tool",
        simulated,
      };
    }
    return {
      kind: "agent",
      title: tool || type,
      detail: content,
      simulated,
    };
  }

  if (type === "model.message") {
    return { kind: "agent", title: "Agent", detail: content || "working", simulated };
  }

  if (type.startsWith("stage.") || type === "turn.created" || type === "turn.done") {
    const stage = typeof rec.stage === "string" ? rec.stage : type;
    const agent = typeof rec.agent === "string" ? rec.agent : "";
    return {
      kind: "stage",
      title: type === "turn.done" ? "Turn complete" : type.replace("stage.", "Stage "),
      detail: [agent, stage].filter(Boolean).join(" · "),
      simulated,
    };
  }

  if (type.startsWith("license.") || type.startsWith("manifest.")) {
    return {
      kind: "license",
      title: type.replace(".", " "),
      detail: content || (typeof rec.manifestSha256 === "string" ? rec.manifestSha256.slice(0, 16) : ""),
      simulated,
    };
  }

  if (type === "state") {
    return {
      kind: "state",
      title: "State",
      detail: [rec.stage, rec.phase].filter((v) => typeof v === "string").join(" · "),
      simulated,
    };
  }

  return { kind: "system", title: type, detail: content, simulated };
}

export function canLicense(view: {
  stage: string;
  phase: string;
  gates: Array<{ id: string; status: string }>;
}): boolean {
  if (view.stage !== "license") return false;
  if (view.phase !== "awaiting-license") return false;
  return view.gates.every((gate) => gate.id === "human-license" || gate.status === "pass");
}

export function simulatedPullRequestUrl(repo: string, migrationId: string): string {
  return `https://github.com/${repo}/pull/demo-${migrationId.toLowerCase()}`;
}
