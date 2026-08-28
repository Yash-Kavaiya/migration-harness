/**
 * Behavioral-parity comparison and diagnosis. Pure: the deterministic half of the
 * parity engine (the `mh-parity` agent supplies only the prose hypothesis on top).
 *
 * The comparison is exact — zero float tolerance. A response that differs from the
 * frozen .NET golden by a single cent is a mismatch, on purpose: that cent is the
 * decimal-rounding trap the demo turns on. Tolerance would hide it.
 *
 * `classifyMismatch` is the taxonomy port (shape adapted from cxas-scrapi
 * `triage-results.py`: a fixed category enum, first matching rule wins, one
 * `(category, detail)` per failing case).
 */

export type MismatchCategory =
  | "DECIMAL_ROUNDING"
  | "FIELD_MISSING"
  | "EXTRA_FIELD"
  | "STATUS_CODE"
  | "TYPE_MISMATCH"
  | "VALUE_MISMATCH"
  | "UNKNOWN";

export const MISMATCH_CATEGORIES: readonly MismatchCategory[] = [
  "DECIMAL_ROUNDING",
  "FIELD_MISSING",
  "EXTRA_FIELD",
  "STATUS_CODE",
  "TYPE_MISMATCH",
  "VALUE_MISMATCH",
  "UNKNOWN",
] as const;

/** Field names that carry run-to-run noise; dropped from both sides before comparison. */
export const DEFAULT_VOLATILE_KEYS: readonly string[] = [
  "timestamp",
  "traceId",
  "traceparent",
  "requestId",
  "correlationId",
  "elapsedMs",
  "durationMs",
  "serverTime",
  "generatedAt",
  "date",
];

export interface NormalizeOptions {
  /** Extra volatile keys to strip, on top of {@link DEFAULT_VOLATILE_KEYS}. */
  volatileKeys?: readonly string[] | undefined;
  /**
   * Money scale from the migration contract. Only used to *classify* a numeric
   * mismatch as `DECIMAL_ROUNDING` vs `VALUE_MISMATCH` — never to make unequal
   * numbers compare equal.
   */
  decimalScale?: number | undefined;
}

/**
 * Canonical form used for the equality decision: object keys sorted, volatile
 * keys removed, `-0` folded to `0`, recursively. Numbers are already canonical
 * once JSON-parsed (`170.00` and `170` are the same value), so scalars pass
 * through untouched — the comparison stays exact.
 */
export function canonicalizeForCompare(value: unknown, opts: NormalizeOptions = {}): unknown {
  const volatile = new Set([...DEFAULT_VOLATILE_KEYS, ...(opts.volatileKeys ?? [])]);
  return walk(value);

  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) {
        if (volatile.has(key)) continue;
        out[key] = walk(src[key]);
      }
      return out;
    }
    if (typeof v === "number" && Object.is(v, -0)) return 0;
    return v;
  }
}

/** Stable JSON of the canonical form. Two parity-equal responses stringify identically. */
export function canonicalJson(value: unknown, opts: NormalizeOptions = {}): string {
  return JSON.stringify(canonicalizeForCompare(value, opts));
}

export interface FieldDiff {
  /** Dotted path from the response root, e.g. `body.total` or `body.items[2].sku`. */
  path: string;
  /** The value in the .NET golden. `undefined` means the field is absent there. */
  expected: unknown;
  /** The value the generated Rust service returned. `undefined` means absent. */
  actual: unknown;
}

const MISSING = Symbol("missing");

/**
 * Structural diff of two already-parsed responses. `expected` is the frozen .NET
 * golden. Returns one entry per differing leaf; an empty array means exact parity.
 */
export function diffResponses(
  expected: unknown,
  actual: unknown,
  opts: NormalizeOptions = {},
): FieldDiff[] {
  const exp = canonicalizeForCompare(expected, opts);
  const act = canonicalizeForCompare(actual, opts);
  const out: FieldDiff[] = [];
  compare("", exp, act, out);
  return out;

  function compare(path: string, e: unknown, a: unknown, acc: FieldDiff[]): void {
    if (e === MISSING) e = undefined;
    if (a === MISSING) a = undefined;

    const eObj = isPlainObject(e);
    const aObj = isPlainObject(a);
    if (eObj && aObj) {
      const keys = new Set([...Object.keys(e as object), ...Object.keys(a as object)]);
      for (const k of [...keys].sort()) {
        const child = path ? `${path}.${k}` : k;
        compare(
          child,
          hasKey(e, k) ? (e as Record<string, unknown>)[k] : MISSING,
          hasKey(a, k) ? (a as Record<string, unknown>)[k] : MISSING,
          acc,
        );
      }
      return;
    }

    const eArr = Array.isArray(e);
    const aArr = Array.isArray(a);
    if (eArr && aArr) {
      const len = Math.max((e as unknown[]).length, (a as unknown[]).length);
      for (let i = 0; i < len; i++) {
        compare(
          `${path}[${i}]`,
          i < (e as unknown[]).length ? (e as unknown[])[i] : MISSING,
          i < (a as unknown[]).length ? (a as unknown[])[i] : MISSING,
          acc,
        );
      }
      return;
    }

    if (!scalarEqual(e, a)) acc.push({ path: path || "$", expected: e, actual: a });
  }
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN never appears in JSON, but guard anyway.
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasKey(o: unknown, k: string): boolean {
  return isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
}

/** Parse a JSON number or a numeric string (`"170.00"`) to a finite number, else null. */
export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Label a single fixture's mismatch. First matching rule wins; the order encodes
 * priority (a wrong status code dominates whatever else drifted underneath it).
 */
export function classifyMismatch(diffs: readonly FieldDiff[], opts: NormalizeOptions = {}): MismatchCategory {
  if (diffs.length === 0) return "UNKNOWN";

  const isStatusPath = (p: string) => /(^|\.)status(code)?$/i.test(p);
  if (diffs.some((d) => isStatusPath(d.path) && d.expected !== undefined && d.actual !== undefined)) {
    return "STATUS_CODE";
  }
  if (diffs.some((d) => d.actual === undefined && d.expected !== undefined)) return "FIELD_MISSING";
  if (diffs.some((d) => d.expected === undefined && d.actual !== undefined)) return "EXTRA_FIELD";

  // DECIMAL_ROUNDING only when *every* diff is a small numeric drift. A fixture
  // that also has an unrelated non-numeric value change is a broader behavioural
  // defect and must not be filed under rounding.
  let sawNumeric = false;
  let allRoundingDrift = true;
  let anyTypeMismatch = false;
  for (const d of diffs) {
    const e = asNumber(d.expected);
    const a = asNumber(d.actual);
    if (e !== null && a !== null) {
      sawNumeric = true;
      if (!isRoundingDrift(e, a, opts.decimalScale)) allRoundingDrift = false;
    } else {
      allRoundingDrift = false;
      if (jsonType(d.expected) !== jsonType(d.actual)) anyTypeMismatch = true;
    }
  }

  if (sawNumeric && allRoundingDrift) return "DECIMAL_ROUNDING";
  if (anyTypeMismatch) return "TYPE_MISMATCH";
  return "VALUE_MISMATCH";
}

/**
 * Two numbers that a rounding-order or float-vs-decimal bug would produce: same
 * magnitude, differ by at most one unit in the last contract place (a cent at
 * scale 2), or by a sub-permille relative amount for accumulation drift.
 */
export function isRoundingDrift(a: number, b: number, decimalScale?: number): boolean {
  if (a === b) return false;
  const diff = Math.abs(a - b);
  const scaleStep = decimalScale === undefined ? 0.01 : 10 ** -decimalScale;
  if (diff <= scaleStep * 1.5) return true;
  const rel = diff / Math.max(Math.abs(a), Math.abs(b), 1);
  return rel <= 1e-3;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export interface FixtureResult {
  fixtureId: string;
  endpoint: { method: string; route: string };
  diffs: FieldDiff[];
}

export interface RouteTally {
  method: string;
  route: string;
  passed: number;
  total: number;
}

export interface ParitySummary {
  total: number;
  passed: number;
  failed: number;
  byRoute: RouteTally[];
  /** Count of failing fixtures per category. Absent categories are omitted. */
  categories: Partial<Record<MismatchCategory, number>>;
  /** The category responsible for the most failures, or null on a clean run. */
  dominantCategory: MismatchCategory | null;
}

/** Roll fixture-level results up into the {@link ParitySummary} the parity gate reads. */
export function summarizeParity(results: readonly FixtureResult[], opts: NormalizeOptions = {}): ParitySummary {
  const byRoute = new Map<string, RouteTally>();
  const categories: Partial<Record<MismatchCategory, number>> = {};
  let passed = 0;

  for (const r of results) {
    const key = `${r.endpoint.method} ${r.endpoint.route}`;
    const tally = byRoute.get(key) ?? { method: r.endpoint.method, route: r.endpoint.route, passed: 0, total: 0 };
    tally.total += 1;
    const ok = r.diffs.length === 0;
    if (ok) {
      tally.passed += 1;
      passed += 1;
    } else {
      const cat = classifyMismatch(r.diffs, opts);
      categories[cat] = (categories[cat] ?? 0) + 1;
    }
    byRoute.set(key, tally);
  }

  let dominantCategory: MismatchCategory | null = null;
  let max = 0;
  for (const cat of MISMATCH_CATEGORIES) {
    const n = categories[cat] ?? 0;
    if (n > max) {
      max = n;
      dominantCategory = cat;
    }
  }

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    byRoute: [...byRoute.values()].sort((x, y) =>
      `${x.method} ${x.route}`.localeCompare(`${y.method} ${y.route}`),
    ),
    categories,
    dominantCategory,
  };
}
