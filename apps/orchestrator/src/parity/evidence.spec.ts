import { describe, expect, it } from "vitest";
import {
  assertBlind,
  buildEvidenceBundle,
  FORBIDDEN_KEYS,
  renderEvidenceBundle,
  truncateTail,
  type BuildEvidenceInput,
} from "./evidence.js";

function input(over: Partial<BuildEvidenceInput> = {}): BuildEvidenceInput {
  return {
    migrationId: "MH-0042",
    totalFixtures: 384,
    failed: 2,
    round: 1,
    mismatches: [
      {
        fixtureId: "fx-0007",
        endpoint: { method: "POST", route: "/quote" },
        input: { body: { subtotal: 249.95, coupon: "SUMMER10" } },
        dotnet: { status: 200, body: { total: "244.08" } },
        rust: { status: 200, body: { total: "244.07" } },
        // A caller that spreads a raw ParityReport row would carry these:
        hypothesis: "banker's rounding vs half-up",
        diff: [{ path: "body.total", expected: "244.08", actual: "244.07" }],
      },
    ],
    cargo: { exitCode: 101, stdout: "running 384 tests\nfx-0007 ... FAILED", stderr: "" },
    ...over,
  };
}

describe("buildEvidenceBundle — the blindness guarantee", () => {
  it("keeps the evidence the repair agent is allowed to see", () => {
    const b = buildEvidenceBundle(input());
    expect(b.migrationId).toBe("MH-0042");
    expect(b.failed).toBe(2);
    expect(b.mismatches[0]).toMatchObject({
      fixtureId: "fx-0007",
      endpoint: { method: "POST", route: "/quote" },
      request: { body: { subtotal: 249.95, coupon: "SUMMER10" } },
      dotnet: { status: 200, body: { total: "244.08" } },
      rust: { status: 200, body: { total: "244.07" } },
    });
    expect(b.cargo.exitCode).toBe(101);
  });

  it("drops mh-parity's hypothesis and any pre-computed diff", () => {
    const b = buildEvidenceBundle(input());
    const json = JSON.stringify(b);
    expect(json).not.toContain("banker's rounding");
    expect(json).not.toContain("hypothesis");
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(json).not.toContain(`"${forbidden}":`);
    }
  });

  it("throws if a mapper ever spreads parity metadata into a mismatch wrapper", () => {
    const b = buildEvidenceBundle(input());
    // simulate a regressed `chosen.map(m => ({ ...m, ... }))`
    (b.mismatches[0] as unknown as Record<string, unknown>).hypothesis = "banker's rounding";
    expect(() => assertBlind(b)).toThrow(/hypothesis/);
  });

  it("throws if the bundle wrapper grows an unexpected key", () => {
    const b = buildEvidenceBundle(input());
    (b as unknown as Record<string, unknown>).classification = "DECIMAL_ROUNDING";
    expect(() => assertBlind(b)).toThrow(/classification/);
  });

  it("does NOT reject a real API payload whose fields happen to be named like metadata", () => {
    const withMetaLikeFields = input({
      failed: 1,
      mismatches: [
        {
          fixtureId: "fx-0001",
          endpoint: { method: "POST", route: "/quote" },
          input: { body: { source: "web" } },
          dotnet: { status: 400, body: { error: { category: "validation", source: "subtotal", suggestion: "send >= 0" } } },
          rust: { status: 200, body: {} },
        },
      ],
    });
    expect(() => buildEvidenceBundle(withMetaLikeFields)).not.toThrow();
    const json = JSON.stringify(buildEvidenceBundle(withMetaLikeFields));
    expect(json).toContain('"category":"validation"'); // payload preserved verbatim
    expect(json).toContain('"source":"subtotal"');
  });

  it("the rendered prompt carries no forbidden key and no Rust source", () => {
    const text = renderEvidenceBundle(buildEvidenceBundle(input()));
    expect(text).not.toContain("banker's rounding");
    expect(text).not.toMatch(/\bpub fn \b/);
    expect(text).not.toMatch(/\bimpl \w/);
    expect(text).toContain("fx-0007");
    expect(text).toContain("244.08");
  });
});

describe("cargo output truncation", () => {
  it("keeps the tail — a failing run puts the useful part at the end", () => {
    const long = "x".repeat(30_000) + "PANIC HERE";
    const trimmed = truncateTail(long, 20_000);
    expect(trimmed.length).toBeLessThan(long.length);
    expect(trimmed).toContain("PANIC HERE");
    expect(trimmed).toContain("chars trimmed");
  });

  it("passes short output through untouched", () => {
    expect(truncateTail("all 384 tests passed", 20_000)).toBe("all 384 tests passed");
  });

  it("bundle truncates both streams to 20k", () => {
    const b = buildEvidenceBundle(input({ cargo: { exitCode: 101, stdout: "y".repeat(50_000), stderr: "z".repeat(50_000) } }));
    expect(b.cargo.stdout.length).toBeLessThanOrEqual(20_050);
    expect(b.cargo.stderr.length).toBeLessThanOrEqual(20_050);
  });
});

describe("mismatch capping", () => {
  it("quotes at most maxMismatches and counts the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      fixtureId: `fx-${String(i + 1).padStart(4, "0")}`,
      endpoint: { method: "POST", route: "/quote" },
      input: {},
      dotnet: {},
      rust: {},
    }));
    const b = buildEvidenceBundle(input({ mismatches: many, failed: 20, maxMismatches: 5 }));
    expect(b.shown).toBe(5);
    expect(b.omitted).toBe(15);
    expect(b.mismatches).toHaveLength(5);
    expect(renderEvidenceBundle(b)).toContain("15 more failures not quoted");
  });
});
