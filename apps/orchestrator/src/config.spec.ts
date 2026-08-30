import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig demo mode", () => {
  it("defaults to live TrueForge mode", () => {
    expect(loadConfig({}).MH_DEMO_MODE).toBe(false);
  });

  it("accepts explicit true and false environment values", () => {
    expect(loadConfig({ MH_DEMO_MODE: "true" }).MH_DEMO_MODE).toBe(true);
    expect(loadConfig({ MH_DEMO_MODE: "false" }).MH_DEMO_MODE).toBe(false);
  });

  it("rejects ambiguous boolean values", () => {
    expect(() => loadConfig({ MH_DEMO_MODE: "yes" })).toThrow(/MH_DEMO_MODE/);
  });
});
