/**
 * Pulling a stage's artifact out of the TrueForge workspace and parsing it.
 *
 * Agents are told to write a bare JSON file, but models still wrap output in
 * ```json fences or lead with prose. The extraction here mirrors cxas-scrapi
 * `designer.py`, hardened: strip fences, then walk every `{`/`[` in the text and
 * try to parse a balanced, string-aware JSON value starting there. The first that
 * parses wins. Only when none do is `{ error: "JSON Parse Failure", raw }`
 * returned, so prose containing stray braces ("use {this format}: {...}") no
 * longer defeats a valid artifact. Never throws.
 */
import type { AgentGateway } from "../trueforge.js";

export interface ParseFailure {
  error: "JSON Parse Failure";
  raw: string;
}

export function isParseFailure(v: unknown): v is ParseFailure {
  return !!v && typeof v === "object" && (v as ParseFailure).error === "JSON Parse Failure";
}

/**
 * From `text[start]` (which must be `{` or `[`), return the index just past the
 * balanced closing delimiter, tracking string literals and escapes so braces
 * inside `"…"` don't count. Returns -1 if it never balances.
 */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Extract the first parseable JSON value from an agent's raw file content. Never throws. */
export function extractJson(raw: string): unknown {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();

  let attempts = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch !== "{" && ch !== "[") continue;
    if (++attempts > 200) break; // pathological prose — give up rather than scan O(n²)

    const end = balancedEnd(stripped, i);
    const candidates = end !== -1 ? [stripped.slice(i, end)] : [];
    // Also try to the end of the text, for a truncated-but-otherwise-valid tail.
    candidates.push(stripped.slice(i));

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* try the next start position */
      }
    }
  }

  return { error: "JSON Parse Failure", raw };
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
