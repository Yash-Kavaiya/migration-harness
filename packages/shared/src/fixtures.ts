/**
 * Deterministic differential-parity fixture matrix.
 *
 * Shape ported from cxas-scrapi `eval_generator.py` (`DeterministicEvalGenerator`):
 * a pure generator that walks a structured description and emits a flat, stably
 * ordered list of cases with fixed ids — no LLM, no randomness, reproducible from
 * the contract alone.
 *
 * The generator emits fixture *requests*. Their `.NET` golden responses are
 * captured separately (once, locally, against the real service) and committed as
 * `demo/fixtures/*.json`; from then on the sandbox only ever runs Rust.
 *
 * Request-body field names follow the OrderPricingService contract in
 * `docs/strategy-notes.md`: `customerTier`, `subtotal`, `coupon`, `country`.
 */

export interface FixtureEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  route: string;
}

export type FixtureCategory = "happy" | "boundary" | "adversarial" | "error" | "regression";

export interface FixtureProvenance {
  repo: string;
  commit: string;
}

export interface FixtureRequest {
  /** `fx-0001`, `fx-0002`, … assigned in generation order. */
  id: string;
  endpoint: FixtureEndpoint;
  category: FixtureCategory;
  request: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  };
  /** Human-readable note on why this case exists — kept out of the wire fixture. */
  note: string;
  /** The repo/commit the golden will be captured against (schema `generatedFrom`). */
  generatedFrom?: FixtureProvenance;
}

export function fixtureId(n: number): string {
  return `fx-${String(n).padStart(4, "0")}`;
}

/** True for an `x.xx5` value — the third decimal is 5, where 2dp rounding is ambiguous. */
export function isRoundingMidpoint(value: number): boolean {
  return Math.round(Math.abs(value) * 1000) % 10 === 5;
}

/** The pricing dimensions the matrix sweeps. Overridable so tests can shrink it. */
export interface MatrixDimensions {
  tiers: string[];
  /** Subtotals chosen to exercise rounding: exact, sub-cent, and `x.xx5` midpoints. */
  subtotals: number[];
  /** `null` means "no coupon"; the rest include one unknown code. */
  coupons: (string | null)[];
  countries: string[];
}

export const DEFAULT_DIMENSIONS: MatrixDimensions = {
  tiers: ["standard", "silver", "gold"],
  subtotals: [0, 0.01, 9.99, 100, 170.005, 224.955, 249.95, 999999.99],
  coupons: [null, "SUMMER10", "EXPIRED20", "BOGUS"],
  countries: ["IN", "US", "GB"],
};

/** Cases that probe validation and hostile input, independent of the sweep. */
interface BoundaryCase {
  category: FixtureCategory;
  body: unknown;
  note: string;
}

const BOUNDARY_CASES: BoundaryCase[] = [
  { category: "error", body: { customerTier: "standard", subtotal: -1, coupon: null, country: "US" }, note: "negative subtotal → 400" },
  { category: "error", body: { customerTier: "platinum", subtotal: 100, coupon: null, country: "US" }, note: "unknown tier → 400" },
  { category: "boundary", body: { customerTier: "gold", subtotal: 999999999.99, coupon: "SUMMER10", country: "US" }, note: "very large subtotal" },
  { category: "adversarial", body: { customerTier: "standard", subtotal: "100", coupon: null, country: "US" }, note: "subtotal as string — wrong type" },
  { category: "adversarial", body: { customerTier: "standard", subtotal: 100, coupon: "ＳＵＭＭＥＲ１０", country: "US" }, note: "unicode full-width coupon" },
  { category: "adversarial", body: { customerTier: "standard", subtotal: 100, country: "US" }, note: "missing coupon field" },
  { category: "boundary", body: { customerTier: "standard", subtotal: 0, coupon: null, country: "US" }, note: "zero subtotal" },
];

export interface GenerateMatrixOptions {
  /** Contract routes to cover. `/quote` gets the full sweep; others get a single smoke case. */
  endpoints: FixtureEndpoint[];
  dimensions?: Partial<MatrixDimensions>;
  /** Repo/commit the goldens will be captured against — recorded on every fixture. */
  source?: FixtureProvenance;
}

/**
 * Build the full fixture matrix: the cartesian sweep on `POST /quote`, one smoke
 * case per other route, plus the boundary block. Order is stable, so ids are
 * stable across runs.
 */
export function generateFixtureMatrix(opts: GenerateMatrixOptions): FixtureRequest[] {
  const dims: MatrixDimensions = { ...DEFAULT_DIMENSIONS, ...opts.dimensions };
  const out: FixtureRequest[] = [];
  let n = 0;
  const next = (
    endpoint: FixtureEndpoint,
    category: FixtureCategory,
    request: FixtureRequest["request"],
    note: string,
  ): void => {
    out.push({
      id: fixtureId(++n),
      endpoint,
      category,
      request,
      note,
      ...(opts.source ? { generatedFrom: { repo: opts.source.repo, commit: opts.source.commit } } : {}),
    });
  };

  const quote = opts.endpoints.find((e) => e.method === "POST" && e.route === "/quote");
  if (quote) {
    for (const customerTier of dims.tiers) {
      for (const subtotal of dims.subtotals) {
        for (const coupon of dims.coupons) {
          for (const country of dims.countries) {
            const isMidpoint = isRoundingMidpoint(subtotal);
            next(
              quote,
              isMidpoint ? "regression" : "happy",
              { body: { customerTier, subtotal, coupon, country } },
              `${customerTier} / ${subtotal} / ${coupon ?? "no-coupon"} / ${country}` +
                (isMidpoint ? " (rounding midpoint)" : ""),
            );
          }
        }
      }
    }
  }

  for (const endpoint of opts.endpoints) {
    if (endpoint.method === "POST" && endpoint.route === "/quote") continue;
    if (endpoint.method === "GET") {
      next(endpoint, "happy", {}, `${endpoint.method} ${endpoint.route} smoke`);
    } else {
      next(
        endpoint,
        "happy",
        { body: { customerTier: "standard", subtotal: 100, coupon: null, country: "US" } },
        `${endpoint.method} ${endpoint.route} smoke`,
      );
    }
  }

  if (quote) {
    for (const bc of BOUNDARY_CASES) {
      next(quote, bc.category, { body: bc.body }, bc.note);
    }
  }

  return out;
}

/** Routes covered by at least one fixture — used to check the matrix against the contract. */
export function coveredRoutes(fixtures: readonly FixtureRequest[]): Set<string> {
  return new Set(fixtures.map((f) => `${f.endpoint.method} ${f.endpoint.route}`));
}
