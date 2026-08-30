import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));
const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

const EXPECTED_SKILLS = [
  "behavioral-parity",
  "dotnet-analysis",
  "dotnet-to-rust",
  "rust-axum",
  "secure-migration",
].sort();

function skillDirs(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((f) => statSync(join(SKILLS_DIR, f)).isDirectory())
    .sort();
}

function parseFrontmatter(md: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!match) return {};
  return Object.fromEntries(
    match[1]!
      .split("\n")
      .filter((l) => l.includes(":"))
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

describe("skills/", () => {
  it("contains exactly the five expected skill packs", () => {
    expect(skillDirs()).toEqual(EXPECTED_SKILLS);
  });

  it.each(EXPECTED_SKILLS)("%s/SKILL.md has valid frontmatter", (name) => {
    const md = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(md);
    expect(fm.name, "frontmatter name matches directory").toBe(name);
    expect(fm.description?.length ?? 0, "has a non-trivial description").toBeGreaterThan(20);
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    expect(body.length, "has a body").toBeGreaterThan(200);
  });

  it("every skill referenced by an agent exists on disk", () => {
    const referenced = new Set<string>();
    for (const f of readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json"))) {
      const spec = JSON.parse(readFileSync(join(AGENTS_DIR, f), "utf8")) as {
        manifest: { skills?: Array<{ name: string }> };
      };
      for (const s of spec.manifest.skills ?? []) referenced.add(s.name);
    }
    for (const name of referenced) {
      expect(EXPECTED_SKILLS, `agent references skill "${name}"`).toContain(name);
    }
    // and every skill on disk is actually used by some agent
    for (const name of EXPECTED_SKILLS) {
      expect([...referenced], `skill "${name}" is referenced by an agent`).toContain(name);
    }
  });

  it("the decimal/money rule is present in the mapping skill", () => {
    const md = readFileSync(join(SKILLS_DIR, "dotnet-to-rust", "SKILL.md"), "utf8");
    expect(md).toMatch(/rust_decimal/);
    expect(md).toMatch(/[Nn]ever\s+`?f64`?/);
    expect(md).toMatch(/MidpointNearestEven|banker/i);
  });
});
