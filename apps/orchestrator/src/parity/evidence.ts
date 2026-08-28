/**
 * Deterministic evidence bundle for the repair agent.
 *
 * Port of `cxas-harness/gauntlet/evidence.py`. This is code, not an agent: the
 * repair agent (`mh-repair`) sees exactly what this produces and nothing else —
 * no source, no field-level diff, no `mh-parity` hypothesis, no scripted fix. That
 * exclusion is what forces `mh-repair` to diagnose the decimal-rounding trap on
 * its own instead of being told the answer. The guarantee is asserted by
 * `evidence.spec.ts` so it survives future edits to this file.
 */

/** The `mh-parity` output shape this module reads (a subset of ParityReport). */
export interface ParityMismatchInput {
  fixtureId: string;
  endpoint: { method: string; route: string };
  input: unknown;
  dotnet: unknown;
  rust: unknown;
  /** mh-parity's prose guess — deliberately read and dropped here. */
  hypothesis?: string;
  diff?: unknown;
}

export interface CargoOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BuildEvidenceInput {
  migrationId: string;
  totalFixtures: number;
  failed: number;
  mismatches: readonly ParityMismatchInput[];
  cargo: CargoOutput;
  /** Round number, so the bundle is reproducible and the agent can see progress. */
  round: number;
  /** Cap on mismatches quoted in full. The rest are counted, not shown. */
  maxMismatches?: number;
}

export interface EvidenceMismatch {
  fixtureId: string;
  endpoint: { method: string; route: string };
  request: unknown;
  /** The frozen .NET golden response for this fixture. */
  dotnet: unknown;
  /** What the generated Rust service returned. */
  rust: unknown;
}

export interface EvidenceBundle {
  migrationId: string;
  round: number;
  totalFixtures: number;
  failed: number;
  shown: number;
  omitted: number;
  mismatches: EvidenceMismatch[];
  cargo: CargoOutput;
}

/**
 * Keys that must never appear anywhere in a bundle. The first five are the
 * verbatim `FORBIDDEN_KEYS` from the donor; the rest are the MigrationHarness
 * leakage vectors — `mh-parity`'s prose and any pre-computed fix.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "source",
  "diff",
  "rationale",
  "commit_message",
  "builder_notes",
  "hypothesis",
  "category",
  "classification",
  "fix",
  "patch",
  "suggestion",
  "remediation",
]);

/** Keep the last `n` characters — a failing `cargo` run puts the useful part at the end. */
export function truncateTail(text: string, n = 20_000): string {
  if (text.length <= n) return text;
  return `…(${text.length - n} chars trimmed)…\n${text.slice(-n)}`;
}

/**
 * Walk a value and throw if any object key is in {@link FORBIDDEN_KEYS}. Called on
 * every bundle before it is returned, and again by the test suite.
 */
export function assertBlind(value: unknown, path = "bundle"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertBlind(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        throw new Error(`evidence bundle would leak "${k}" to the repair agent (at ${path}.${k})`);
      }
      assertBlind(v, `${path}.${k}`);
    }
  }
}

export function buildEvidenceBundle(input: BuildEvidenceInput): EvidenceBundle {
  const cap = input.maxMismatches ?? 12;
  const chosen = input.mismatches.slice(0, cap);

  const bundle: EvidenceBundle = {
    migrationId: input.migrationId,
    round: input.round,
    totalFixtures: input.totalFixtures,
    failed: input.failed,
    shown: chosen.length,
    omitted: Math.max(0, input.mismatches.length - chosen.length),
    mismatches: chosen.map((m) => ({
      fixtureId: m.fixtureId,
      endpoint: { method: m.endpoint.method, route: m.endpoint.route },
      request: m.input,
      dotnet: m.dotnet,
      rust: m.rust,
    })),
    cargo: {
      exitCode: input.cargo.exitCode,
      stdout: truncateTail(input.cargo.stdout),
      stderr: truncateTail(input.cargo.stderr),
    },
  };

  // Defense in depth: a caller that spreads a raw ParityReport row in here would
  // carry `hypothesis`/`diff` along. Fail loudly rather than leak.
  assertBlind(bundle);
  return bundle;
}

/** Render the bundle as the plain-text block handed to `mh-repair` as turn input. */
export function renderEvidenceBundle(bundle: EvidenceBundle): string {
  const lines: string[] = [
    `# Parity evidence — ${bundle.migrationId} (repair round ${bundle.round})`,
    `${bundle.failed} of ${bundle.totalFixtures} fixtures do not match the frozen .NET golden.`,
    bundle.omitted > 0
      ? `Showing ${bundle.shown}; ${bundle.omitted} more failures not quoted.`
      : `All ${bundle.shown} failing fixtures shown below.`,
    "",
    "## Failing fixtures",
  ];

  for (const m of bundle.mismatches) {
    lines.push(
      "",
      `### ${m.fixtureId} — ${m.endpoint.method} ${m.endpoint.route}`,
      "request:",
      "```json",
      JSON.stringify(m.request, null, 2),
      "```",
      ".NET (expected):",
      "```json",
      JSON.stringify(m.dotnet, null, 2),
      "```",
      "Rust (actual):",
      "```json",
      JSON.stringify(m.rust, null, 2),
      "```",
    );
  }

  lines.push(
    "",
    "## cargo test --test parity",
    `exit code: ${bundle.cargo.exitCode}`,
    "```",
    bundle.cargo.stdout || bundle.cargo.stderr || "(no output)",
    "```",
  );

  return lines.join("\n");
}
