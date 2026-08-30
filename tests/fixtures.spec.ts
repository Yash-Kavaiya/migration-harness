import { describe, expect, it } from "vitest";
import {
  coveredRoutes,
  DEFAULT_DIMENSIONS,
  fixtureId,
  generateFixtureMatrix,
  isRoundingMidpoint,
  type FixtureEndpoint,
} from "@mh/shared/fixtures";

const ENDPOINTS: FixtureEndpoint[] = [
  { method: "GET", route: "/health" },
  { method: "GET", route: "/rules" },
  { method: "POST", route: "/quote" },
  { method: "POST", route: "/discount" },
  { method: "POST", route: "/shipping" },
];

describe("generateFixtureMatrix", () => {
  it("is deterministic — same input, byte-identical output", () => {
    const a = generateFixtureMatrix({ endpoints: ENDPOINTS });
    const b = generateFixtureMatrix({ endpoints: ENDPOINTS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("assigns sequential fx-NNNN ids with no gaps", () => {
    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    expect(fx[0]?.id).toBe("fx-0001");
    fx.forEach((f, i) => expect(f.id).toBe(fixtureId(i + 1)));
  });

  it("sweeps the full cartesian product on POST /quote", () => {
    const d = DEFAULT_DIMENSIONS;
    const expectedSweep = d.tiers.length * d.subtotals.length * d.coupons.length * d.countries.length;
    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    const quoteSweep = fx.filter((f) => f.endpoint.route === "/quote" && f.category !== "error" && f.category !== "adversarial" && f.category !== "boundary");
    expect(quoteSweep.length).toBe(expectedSweep);
  });

  it("covers every contract route with at least one fixture", () => {
    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    const covered = coveredRoutes(fx);
    for (const e of ENDPOINTS) expect(covered.has(`${e.method} ${e.route}`)).toBe(true);
  });

  it("serializes /quote bodies with the contract field names (customerTier, not tier)", () => {
    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    const quoteBodies = fx
      .filter((f) => f.endpoint.route === "/quote" && f.request.body && typeof f.request.body === "object")
      .map((f) => f.request.body as Record<string, unknown>);
    expect(quoteBodies.length).toBeGreaterThan(0);
    for (const body of quoteBodies) {
      expect(body).not.toHaveProperty("tier");
      // every nominal case names the tier field; adversarial "missing field" cases may omit others
      if ("customerTier" in body) expect(typeof body.customerTier).toBe("string");
    }
    // the happy sweep always carries all four fields
    const happy = fx.find((f) => f.category === "happy" && f.endpoint.route === "/quote")!;
    expect(Object.keys(happy.request.body as object).sort()).toEqual(["country", "coupon", "customerTier", "subtotal"]);
  });

  it("stamps generatedFrom provenance on every fixture when a source is given", () => {
    const fx = generateFixtureMatrix({
      endpoints: ENDPOINTS,
      source: { repo: "acme/orderpricing", commit: "abc1234" },
    });
    expect(fx.every((f) => f.generatedFrom?.repo === "acme/orderpricing" && f.generatedFrom.commit === "abc1234")).toBe(true);
  });

  it("omits generatedFrom when no source is given", () => {
    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    expect(fx.every((f) => f.generatedFrom === undefined)).toBe(true);
  });

  it("includes the validation / adversarial boundary block", () => {
    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    expect(fx.some((f) => f.category === "error" && f.note.includes("negative subtotal"))).toBe(true);
    expect(fx.some((f) => f.category === "adversarial" && f.note.includes("wrong type"))).toBe(true);
    expect(fx.some((f) => f.category === "adversarial" && f.note.includes("unicode"))).toBe(true);
  });

  it("marks x.xx5 rounding-midpoint subtotals as regression cases", () => {
    expect(isRoundingMidpoint(224.955)).toBe(true);
    expect(isRoundingMidpoint(170.005)).toBe(true);
    expect(isRoundingMidpoint(999999.99)).toBe(false);
    expect(isRoundingMidpoint(100)).toBe(false);

    const fx = generateFixtureMatrix({ endpoints: ENDPOINTS });
    const midpoints = fx.filter((f) => f.category === "regression");
    expect(midpoints.length).toBeGreaterThan(0);
    for (const f of midpoints) {
      expect(isRoundingMidpoint((f.request.body as { subtotal: number }).subtotal)).toBe(true);
    }
  });

  it("shrinks cleanly for tests via dimension overrides", () => {
    const fx = generateFixtureMatrix({
      endpoints: [{ method: "POST", route: "/quote" }],
      dimensions: { tiers: ["standard"], subtotals: [100], coupons: [null], countries: ["US"] },
    });
    // 1 sweep case + 7 boundary cases
    expect(fx.filter((f) => f.category === "happy")).toHaveLength(1);
    expect(fx.length).toBe(1 + 7);
  });

  it("handles a contract with no /quote route (smoke cases only)", () => {
    const fx = generateFixtureMatrix({ endpoints: [{ method: "GET", route: "/health" }] });
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ id: "fx-0001", endpoint: { method: "GET", route: "/health" }, category: "happy" });
  });
});
