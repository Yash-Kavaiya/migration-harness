import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalizeForCompare,
  classifyMismatch,
  diffResponses,
  isRoundingDrift,
  summarizeParity,
  type FixtureResult,
} from "@mh/shared/parity";

describe("canonicalizeForCompare", () => {
  it("sorts object keys recursively and folds -0", () => {
    const a = canonicalizeForCompare({ b: 1, a: { d: -0, c: 2 } });
    expect(JSON.stringify(a)).toBe('{"a":{"c":2,"d":0},"b":1}');
  });

  it("drops volatile keys on both sides so they never diff", () => {
    const golden = { total: "10.00", timestamp: "2026-08-28T12:00:00Z", traceId: "abc" };
    const rust = { total: "10.00", timestamp: "2026-08-28T12:00:09Z", traceId: "zzz" };
    expect(canonicalJson(golden)).toBe(canonicalJson(rust));
    expect(diffResponses(golden, rust)).toEqual([]);
  });

  it("honours extra volatile keys from the contract", () => {
    const opts = { volatileKeys: ["requestScopedId"] };
    expect(diffResponses({ x: 1, requestScopedId: "p" }, { x: 1, requestScopedId: "q" }, opts)).toEqual([]);
  });
});

describe("diffResponses — exact, zero float tolerance", () => {
  it("returns nothing for parity-equal responses (170 vs 170.00)", () => {
    expect(diffResponses({ total: 170 }, { total: 170.0 })).toEqual([]);
    expect(diffResponses({ body: { total: "170.00" } }, { body: { total: "170.00" } })).toEqual([]);
  });

  it("flags a one-cent difference — the decimal trap must survive", () => {
    const diffs = diffResponses({ body: { total: "170.00" } }, { body: { total: "169.99" } });
    expect(diffs).toEqual([{ path: "body.total", expected: "170.00", actual: "169.99" }]);
  });

  it("reports a missing field with actual undefined", () => {
    const diffs = diffResponses({ a: 1, tax: "2.00" }, { a: 1 });
    expect(diffs).toEqual([{ path: "tax", expected: "2.00", actual: undefined }]);
  });

  it("reports an extra field with expected undefined", () => {
    const diffs = diffResponses({ a: 1 }, { a: 1, debug: true });
    expect(diffs).toEqual([{ path: "debug", expected: undefined, actual: true }]);
  });

  it("walks arrays element-wise", () => {
    const diffs = diffResponses({ items: [{ p: "1.00" }, { p: "2.00" }] }, { items: [{ p: "1.00" }, { p: "2.05" }] });
    expect(diffs).toEqual([{ path: "items[1].p", expected: "2.00", actual: "2.05" }]);
  });
});

describe("classifyMismatch — taxonomy", () => {
  it("DECIMAL_ROUNDING for a sub-cent/one-cent numeric drift", () => {
    const diffs = diffResponses({ total: "170.00", tax: "21.25" }, { total: "169.99", tax: "21.24" });
    expect(classifyMismatch(diffs, { decimalScale: 2 })).toBe("DECIMAL_ROUNDING");
  });

  it("VALUE_MISMATCH when a number is wrong by a wide margin", () => {
    const diffs = diffResponses({ total: "170.00" }, { total: "17.00" });
    expect(classifyMismatch(diffs, { decimalScale: 2 })).toBe("VALUE_MISMATCH");
  });

  it("STATUS_CODE dominates whatever drifted under it", () => {
    const diffs = diffResponses(
      { status: 400, body: { error: "subtotal must be >= 0" } },
      { status: 200, body: { total: "0.00" } },
    );
    expect(classifyMismatch(diffs)).toBe("STATUS_CODE");
  });

  it("FIELD_MISSING when the Rust response drops a field", () => {
    expect(classifyMismatch(diffResponses({ a: 1, shipping: "5.00" }, { a: 1 }))).toBe("FIELD_MISSING");
  });

  it("EXTRA_FIELD when the Rust response adds one", () => {
    expect(classifyMismatch(diffResponses({ a: 1 }, { a: 1, stackTrace: "..." }))).toBe("EXTRA_FIELD");
  });

  it("TYPE_MISMATCH when a string became a number", () => {
    const diffs = diffResponses({ total: "170.00" }, { total: { amount: 170 } });
    expect(classifyMismatch(diffs)).toBe("TYPE_MISMATCH");
  });

  it("UNKNOWN for an empty diff", () => {
    expect(classifyMismatch([])).toBe("UNKNOWN");
  });
});

describe("isRoundingDrift", () => {
  it("true for a one-cent gap at scale 2", () => {
    expect(isRoundingDrift(170.0, 169.99, 2)).toBe(true);
  });
  it("true for float-accumulation drift below a permille", () => {
    expect(isRoundingDrift(224.955, 224.95, 2)).toBe(true);
  });
  it("false for equal values and for wide gaps", () => {
    expect(isRoundingDrift(170, 170, 2)).toBe(false);
    expect(isRoundingDrift(170, 150, 2)).toBe(false);
  });
});

describe("the decimal trap end to end", () => {
  const request = { body: { subtotal: 249.95, coupon: "SUMMER10", country: "IN" } };
  const dotnetGolden = { status: 200, body: { discountedSubtotal: "224.96", tax: "19.12", shipping: "0.00", total: "244.08" } };
  const rustNaiveF64 = { status: 200, body: { discountedSubtotal: "224.96", tax: "19.12", shipping: "0.00", total: "244.07" } };
  const rustFixedDecimal = { status: 200, body: { discountedSubtotal: "224.96", tax: "19.12", shipping: "0.00", total: "244.08" } };

  it("first-pass f64 output diverges from the golden by exactly one cent on total", () => {
    const diffs = diffResponses(dotnetGolden, rustNaiveF64);
    expect(diffs).toEqual([{ path: "body.total", expected: "244.08", actual: "244.07" }]);
    expect(classifyMismatch(diffs, { decimalScale: 2 })).toBe("DECIMAL_ROUNDING");
  });

  it("the rust_decimal repair restores exact parity", () => {
    expect(diffResponses(dotnetGolden, rustFixedDecimal)).toEqual([]);
  });

  it("request payload is not part of the comparison", () => {
    expect(diffResponses({ ...dotnetGolden }, { ...rustFixedDecimal, echo: undefined })).toEqual([]);
    expect(request.body.subtotal).toBe(249.95);
  });
});

describe("summarizeParity", () => {
  const ep = (route: string) => ({ method: "POST", route });
  const results: FixtureResult[] = [
    { fixtureId: "fx-0001", endpoint: ep("/quote"), diffs: [] },
    { fixtureId: "fx-0002", endpoint: ep("/quote"), diffs: [{ path: "total", expected: "1.00", actual: "0.99" }] },
    { fixtureId: "fx-0003", endpoint: ep("/quote"), diffs: [{ path: "total", expected: "2.00", actual: "1.99" }] },
    { fixtureId: "fx-0004", endpoint: ep("/shipping"), diffs: [] },
  ];

  it("tallies totals, per-route counts, and the dominant category", () => {
    const s = summarizeParity(results, { decimalScale: 2 });
    expect(s).toMatchObject({ total: 4, passed: 2, failed: 2, dominantCategory: "DECIMAL_ROUNDING" });
    expect(s.categories).toEqual({ DECIMAL_ROUNDING: 2 });
    expect(s.byRoute).toEqual([
      { method: "POST", route: "/quote", passed: 1, total: 3 },
      { method: "POST", route: "/shipping", passed: 1, total: 1 },
    ]);
  });

  it("reports a clean run with a null dominant category", () => {
    const s = summarizeParity([{ fixtureId: "fx-0001", endpoint: ep("/quote"), diffs: [] }]);
    expect(s).toMatchObject({ total: 1, passed: 1, failed: 0, dominantCategory: null });
    expect(s.categories).toEqual({});
  });
});
