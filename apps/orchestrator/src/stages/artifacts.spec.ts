import { describe, expect, it } from "vitest";
import { extractJson, isParseFailure } from "./artifacts.js";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it("strips ```json fences and leading prose", () => {
    const raw = 'Here is the report:\n```json\n{ "status": "PASS" }\n```\nDone.';
    expect(extractJson(raw)).toEqual({ status: "PASS" });
  });

  it("handles a top-level array", () => {
    expect(extractJson("```\n[{\"id\":\"fx-0001\"}]\n```")).toEqual([{ id: "fx-0001" }]);
  });

  it("returns a JSON Parse Failure marker for a truncated stream", () => {
    const out = extractJson('{"status":"PA');
    expect(isParseFailure(out)).toBe(true);
    if (isParseFailure(out)) expect(out.raw).toBe('{"status":"PA');
  });

  it("returns a JSON Parse Failure marker when there is no JSON at all", () => {
    expect(isParseFailure(extractJson("the agent said it could not comply"))).toBe(true);
  });

  it("recovers the object even with trailing prose after it", () => {
    expect(extractJson('{"n":1} and that is my answer')).toEqual({ n: 1 });
  });

  it("skips leading prose that itself contains braces", () => {
    expect(extractJson('Use {this format}: {"status":"PASS"}')).toEqual({ status: "PASS" });
    expect(extractJson('note: arrays like [a, b] are fine\n[{"id":"fx-0001"}]')).toEqual([{ id: "fx-0001" }]);
  });

  it("is not fooled by JSON-looking braces inside string values", () => {
    expect(extractJson('{"msg":"use { and } carefully","ok":true}')).toEqual({
      msg: "use { and } carefully",
      ok: true,
    });
  });
});
