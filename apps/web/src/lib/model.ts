import type {
  AuthorityPanel,
  ControlState,
  MigrationStage,
  MigrationView,
  ParityEvidence,
  TimelineEvent,
} from "./types";
import type { SseEvent } from "./sse";

export interface PipelineStep {
  id: Exclude<MigrationStage, "repair" | "freeze">;
  label: string;
  status: "complete" | "active" | "pending" | "failed";
  detail?: string;
}

export interface OperationalSummary {
  activity: string;
  proof: string;
  authority: string;
}

const PIPELINE: Array<{ id: PipelineStep["id"]; label: string }> = [
  { id: "discover", label: "Discovery" },
  { id: "contract", label: "Contract" },
  { id: "migrate", label: "Generation" },
  { id: "parity", label: "Parity" },
  { id: "security", label: "Security" },
  { id: "license", label: "License" },
  { id: "cutover", label: "Cutover" },
  { id: "complete", label: "Complete" },
];

const STAGE_POSITION: Record<MigrationStage, PipelineStep["id"]> = {
  discover: "discover",
  contract: "contract",
  migrate: "migrate",
  parity: "parity",
  repair: "parity",
  security: "security",
  freeze: "license",
  license: "license",
  cutover: "cutover",
  complete: "complete",
};

const STAGE_ACTIVITY: Record<MigrationStage, string> = {
  discover: "mapping the source architecture",
  contract: "locking the behavioral contract",
  migrate: "generating the Rust implementation",
  parity: "comparing deterministic fixtures",
  repair: "repairing a verified mismatch",
  security: "checking security parity",
  freeze: "freezing the immutable manifest",
  license: "waiting for a human migration license",
  cutover: "publishing the licensed change",
  complete: "preserving the final audit record",
};

export function deriveControlState(view: MigrationView | null): ControlState {
  if (!view) return "contract";
  if (view.terminal || view.stage === "complete") return "complete";
  if (view.stage === "license" || view.phase === "awaiting-license") return "license";
  if (view.stage === "parity" || view.stage === "repair") return "parity";
  return "live";
}

export function derivePipeline(view: MigrationView): PipelineStep[] {
  const activeId = STAGE_POSITION[view.stage];
  const activeIndex = PIPELINE.findIndex((step) => step.id === activeId);

  return PIPELINE.map((step, index) => {
    let status: PipelineStep["status"] = "pending";
    if (view.phase === "complete") status = "complete";
    else if (index < activeIndex) status = "complete";
    else if (index === activeIndex) {
      status = ["blocked", "failed", "halted", "denied"].includes(view.phase) ? "failed" : "active";
    }

    const detail =
      step.id === "parity" && view.stage === "repair"
        ? `repair round ${view.repairRounds} of 3`
        : undefined;
    return { ...step, status, ...(detail ? { detail } : {}) };
  });
}

export function deriveParityMetrics(parity: ParityEvidence | null): {
  passed: number;
  total: number;
  failed: number;
  percent: number;
} {
  if (!parity) return { passed: 0, total: 0, failed: 0, percent: 0 };
  const rawPercent = parity.total > 0 ? Math.round((parity.passed / parity.total) * 100) : 0;
  return {
    passed: parity.passed,
    total: parity.total,
    failed: parity.failed,
    percent: Math.max(0, Math.min(100, rawPercent)),
  };
}

export function deriveOperationalSummary(view: MigrationView): OperationalSummary {
  const currentRun = [...view.stages]
    .reverse()
    .find((run) => run.status === "running" || run.status === "waiting");
  const agent = currentRun?.agent ?? agentNameForStage(view.stage);
  const work = currentRun?.status === "waiting"
    ? "awaiting a human response"
    : currentRun?.detail
      ? lowerFirst(currentRun.detail)
      : STAGE_ACTIVITY[view.stage];
  const passed = view.gates.filter((gate) => gate.status === "pass").length;

  return {
    activity: `${agent} is ${work}`,
    proof: `${passed} of ${view.gates.length} evaluated gates pass`,
    authority: describeAuthority(view.authority),
  };
}

function agentNameForStage(stage: MigrationStage): string {
  if (stage === "freeze" || stage === "license" || stage === "complete") return "The orchestrator";
  return `mh-${stage === "discover" ? "architect" : stage === "migrate" ? "migrator" : stage}`;
}

function describeAuthority(authority: AuthorityPanel): string {
  const granted = [
    authority.repoRead ? "Repository read" : null,
    authority.sandbox ? "sandbox" : null,
    authority.workspaceWrite ? "workspace write" : null,
  ].filter((item): item is string => Boolean(item));
  const base = granted.length > 0 ? sentenceList(granted) : "No execution authority";
  return `${base}. GitHub push ${authority.githubPush}; merge ${authority.merge}.`;
}

function sentenceList(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

export function normalizeStreamEvent(frame: SseEvent, fallbackNow = new Date().toISOString()): TimelineEvent | null {
  const parsed = parseData(frame.data);
  if (frame.event === "persisted" && isRecord(parsed)) {
    const seq = asSequence(parsed.seq, frame.id);
    if (seq === null) return null;
    return {
      seq,
      type: typeof parsed.type === "string" ? parsed.type : "message",
      payload: parsed.payload,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : fallbackNow,
    };
  }

  const seq = asSequence(undefined, frame.id);
  if (seq === null) return null;
  return {
    seq,
    type: frame.event || "message",
    payload: parsed,
    createdAt: fallbackNow,
  };
}

function parseData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSequence(value: unknown, fallback: string | undefined): number | null {
  const numberValue = typeof value === "number" ? value : Number(fallback);
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}
