import { describe, expect, it } from "vitest";
import { canLicense, classifyTimelineEvent, simulatedPullRequestUrl } from "./timeline";

describe("classifyTimelineEvent", () => {
  it("labels github-read MCP calls", () => {
    const classified = classifyTimelineEvent({
      seq: 4,
      type: "tf.tool.call",
      payload: { stage: "discover", event: { type: "tool.call", name: "github-read.get_file_contents" } },
      createdAt: "2026-08-30T10:00:00.000Z",
    });
    expect(classified.kind).toBe("mcp");
    expect(classified.title).toMatch(/github-read/i);
  });

  it("labels sandbox cargo execution", () => {
    const classified = classifyTimelineEvent({
      seq: 9,
      type: "tool.call",
      payload: { name: "sandbox.exec", content: "cargo test --offline" },
      createdAt: "2026-08-30T10:00:00.000Z",
    });
    expect(classified.kind).toBe("sandbox");
    expect(classified.detail).toMatch(/cargo test/);
  });

  it("labels a GitHub write checkpoint", () => {
    const classified = classifyTimelineEvent({
      seq: 40,
      type: "cutover.checkpoint",
      payload: { tool: "create_pull_request" },
      createdAt: "2026-08-30T10:00:00.000Z",
    });
    expect(classified.kind).toBe("approval");
  });
});

describe("canLicense", () => {
  it("stays disabled while any quality gate is red", () => {
    expect(
      canLicense({
        stage: "license",
        phase: "awaiting-license",
        gates: [
          { id: "behavioral-parity", status: "fail" },
          { id: "human-license", status: "pending" },
        ],
      }),
    ).toBe(false);
  });

  it("unlocks when gates 1-8 pass and the human license is the remaining pending gate", () => {
    expect(
      canLicense({
        stage: "license",
        phase: "awaiting-license",
        gates: [
          { id: "discovery", status: "pass" },
          { id: "human-license", status: "pending" },
        ],
      }),
    ).toBe(true);
  });
});

describe("simulatedPullRequestUrl", () => {
  it("never pretends the demo opened a live pull request", () => {
    expect(simulatedPullRequestUrl("acme/orderpricing-legacy", "MH-0001")).toContain("demo-mh-0001");
  });
});
