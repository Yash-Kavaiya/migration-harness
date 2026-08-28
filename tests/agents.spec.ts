import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

interface AgentFile {
  name: string;
  instructionsFile: string;
  manifest: {
    model: { name: string; params?: Record<string, unknown> };
    mcpServers?: Array<{ name: string; enableTools?: string[]; requireApprovalForTools?: string[] }>;
    skills?: Array<{ name: string }>;
    config?: {
      sandbox?: { enabled: boolean };
      askUserQuestions?: { enabled?: boolean };
      dynamicSubAgents?: { enabled?: boolean };
      iterationLimit?: number;
    };
  };
}

const EXPECTED = [
  "mh-architect",
  "mh-contract",
  "mh-migrator",
  "mh-parity",
  "mh-repair",
  "mh-security",
  "mh-cutover",
] as const;

function load(name: string): AgentFile {
  return JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), "utf8")) as AgentFile;
}

const agents = new Map(EXPECTED.map((n) => [n, load(n)]));

describe("agents/ directory", () => {
  it("has exactly the seven pipeline agents, each with a .md and a .json", () => {
    const jsons = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(jsons).toEqual([...EXPECTED].map((n) => `${n}.json`).sort());
    for (const name of EXPECTED) {
      expect(() => readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8")).not.toThrow();
    }
  });

  it.each(EXPECTED)("%s manifest is well formed", (name) => {
    const a = agents.get(name)!;
    expect(a.name).toBe(name);
    expect(a.instructionsFile).toBe(`${name}.md`);
    expect(a.manifest.model.name).toMatch(/^[a-z-]+\/.+/);
    expect(a.manifest.config?.askUserQuestions?.enabled).toBe(false); // pipeline runs unattended
  });
});

describe("least-privilege scope (the safety backbone)", () => {
  it("only mh-cutover can write to GitHub", () => {
    for (const [name, a] of agents) {
      const servers = a.manifest.mcpServers ?? [];
      const names = servers.map((s) => s.name);
      if (name === "mh-cutover") {
        expect(names).toEqual(["github-write"]);
      } else {
        expect(names).not.toContain("github-write");
      }
    }
  });

  it("code-touching agents have no MCP access at all", () => {
    for (const name of ["mh-migrator", "mh-parity", "mh-repair", "mh-security"] as const) {
      expect(agents.get(name)!.manifest.mcpServers ?? []).toEqual([]);
    }
  });

  it("discovery agents get github-read as read-only with no approval prompts", () => {
    for (const name of ["mh-architect", "mh-contract"] as const) {
      const server = (agents.get(name)!.manifest.mcpServers ?? [])[0];
      expect(server?.name).toBe("github-read");
      expect(server?.enableTools).toEqual(["@read-only"]);
      expect(server?.requireApprovalForTools).toEqual([]);
    }
  });

  it("mh-cutover pauses for approval on every GitHub write and has no sandbox", () => {
    const cutover = agents.get("mh-cutover")!;
    const server = (cutover.manifest.mcpServers ?? [])[0]!;
    expect(server.enableTools).toEqual(["@all"]);
    expect(server.requireApprovalForTools).toEqual(["@all"]);
    expect(cutover.manifest.config?.sandbox?.enabled).toBe(false);
    expect(cutover.manifest.skills ?? []).toEqual([]);
  });

  it("every agent except mh-cutover runs in a sandbox", () => {
    for (const [name, a] of agents) {
      expect(a.manifest.config?.sandbox?.enabled).toBe(name !== "mh-cutover");
    }
  });

  it("only mh-parity may fan out into dynamic subagents", () => {
    for (const [name, a] of agents) {
      expect(a.manifest.config?.dynamicSubAgents?.enabled ?? false).toBe(name === "mh-parity");
    }
  });

  it("skills line up with each agent's job", () => {
    const skillsOf = (n: (typeof EXPECTED)[number]) =>
      (agents.get(n)!.manifest.skills ?? []).map((s) => s.name).sort();
    expect(skillsOf("mh-architect")).toEqual(["dotnet-analysis"]);
    expect(skillsOf("mh-contract")).toEqual(["behavioral-parity"]);
    expect(skillsOf("mh-migrator")).toEqual(["dotnet-to-rust", "rust-axum"]);
    expect(skillsOf("mh-parity")).toEqual(["behavioral-parity"]);
    expect(skillsOf("mh-repair")).toEqual(["dotnet-to-rust", "rust-axum"]);
    expect(skillsOf("mh-security")).toEqual(["secure-migration"]);
  });
});
