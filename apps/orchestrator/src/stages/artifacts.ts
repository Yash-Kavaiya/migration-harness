/**
 * Pulling a stage's artifact out of the TrueForge workspace and parsing it.
 *
 * Agents are told to write a bare JSON file, but models still wrap output in
 * ```json fences or lead with prose. The extraction here mirrors cxas-scrapi
 * `designer.py`: strip fences, seek the first `{` or `[`, parse; on failure hand
 * back `{ error: "JSON Parse Failure", raw }` so the caller fails the stage with a
 * useful payload instead of throwing on a truncated stream.
 */
import type { AgentGateway } from "../trueforge.js";

export interface ParseFailure {
  error: "JSON Parse Failure";
  raw: string;
}

export function isParseFailure(v: unknown): v is ParseFailure {
  return !!v && typeof v === "object" && (v as ParseFailure).error === "JSON Parse Failure";
}

/** Extract the first JSON value from an agent's raw file content. Never throws. */
export function extractJson(raw: string): unknown {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const firstObj = stripped.indexOf("{");
  const firstArr = stripped.indexOf("[");
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return { error: "JSON Parse Failure", raw };

  const open = stripped[start];
  const close = open === "{" ? "}" : "]";
  const end = stripped.lastIndexOf(close);
  const candidate = end > start ? stripped.slice(start, end + 1) : stripped.slice(start);

  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(stripped.slice(start));
    } catch {
      return { error: "JSON Parse Failure", raw };
    }
  }
}

export async function downloadJson(
  gateway: AgentGateway,
  session: { sessionId: string; turnId: string | null },
  path: string,
): Promise<unknown> {
  if (!session.turnId) return { error: "JSON Parse Failure", raw: "" };
  const raw = await gateway.downloadArtifact({
    sessionId: session.sessionId,
    turnId: session.turnId,
    path,
  });
  return extractJson(raw);
}
