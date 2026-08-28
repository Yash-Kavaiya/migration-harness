/**
 * Applies agents/*.json to the TrueForge server.
 *
 *   tsx scripts/sync-agents.ts --dry-run   show what would change, touch nothing
 *   tsx scripts/sync-agents.ts             create missing agents, update changed ones
 *   tsx scripts/sync-agents.ts --check     exit 1 if the server has drifted from these files
 *
 * Needs TRUEFORGE_BASE_URL (and TRUEFORGE_API_KEY when the server has auth enabled),
 * from the environment or a .env file at the repo root.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");

const AGENT_NAMES = [
  "mh-architect",
  "mh-contract",
  "mh-migrator",
  "mh-parity",
  "mh-security",
  "mh-repair",
  "mh-cutover",
] as const;

interface AgentFile {
  name: string;
  instructionsFile: string;
  manifest: Record<string, unknown>;
}

function loadEnv(): void {
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env"));
  } catch {
    // no .env — rely on the ambient environment
  }
}

/** Strip a leading `# Title` line and any trailing whitespace from the markdown. */
function instructionsFromMarkdown(md: string): string {
  return md.replace(/^\s*#\s+\S.*\n/, "").trim();
}

function loadAgent(name: string): { name: string; manifest: Record<string, unknown> } {
  const spec = JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), "utf8")) as AgentFile;
  const md = readFileSync(join(AGENTS_DIR, spec.instructionsFile), "utf8");
  const model = spec.manifest.model as { name: string; params?: Record<string, unknown> };
  const override = process.env.MH_AGENT_MODEL;
  return {
    name: spec.name,
    manifest: {
      ...spec.manifest,
      model: override ? { ...model, name: override } : model,
      instructions: instructionsFromMarkdown(md),
    },
  };
}

/** Canonical JSON (sorted keys) for a stable before/after comparison. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(value));
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--dry-run")
      ? "dry-run"
      : "apply";

  loadEnv();
  const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
  const token = process.env.TRUEFORGE_API_KEY;
  const client = new TrueForge(token ? { baseUrl, token } : { baseUrl });

  const local = AGENT_NAMES.map(loadAgent);

  const { data: remoteAgents } = await client.agents.list();
  const remoteByName = new Map(remoteAgents.map((a) => [a.name, a]));

  // Warn about referenced MCP servers / skills that don't exist on the server yet.
  await warnMissingReferences(client, local);

  let drift = 0;
  for (const agent of local) {
    const remote = remoteByName.get(agent.name);
    if (!remote) {
      drift++;
      console.log(`+ ${agent.name}  (missing on server — will create)`);
      if (mode === "apply") {
        await client.agents.create({ name: agent.name, manifest: agent.manifest as never });
        console.log(`  created`);
      }
      continue;
    }

    if (canonical(remote.manifest) === canonical(agent.manifest)) {
      console.log(`= ${agent.name}  (up to date)`);
      continue;
    }

    drift++;
    console.log(`~ ${agent.name}  (manifest differs — will update)`);
    if (mode === "apply") {
      await client.agents.update(remote.id, { manifest: agent.manifest as never });
      console.log(`  updated`);
    }
  }

  const managed = new Set<string>(AGENT_NAMES);
  for (const remote of remoteAgents) {
    if (remote.name.startsWith("mh-") && !managed.has(remote.name)) {
      console.log(`? ${remote.name}  (on server, not in agents/ — left alone)`);
    }
  }

  if (mode === "check" && drift > 0) {
    console.error(`\n${drift} agent(s) out of sync. Run: npm run sync-agents`);
    process.exit(1);
  }
  console.log(mode === "apply" ? "\ndone" : `\n${drift === 0 ? "in sync" : `${drift} change(s) pending`}`);
}

async function warnMissingReferences(
  client: TrueForge,
  local: Array<{ name: string; manifest: Record<string, unknown> }>,
): Promise<void> {
  const referencedMcp = new Set<string>();
  const referencedSkills = new Set<string>();
  for (const a of local) {
    for (const s of (a.manifest.mcpServers as Array<{ name: string }>) ?? []) referencedMcp.add(s.name);
    for (const s of (a.manifest.skills as Array<{ name: string }>) ?? []) referencedSkills.add(s.name);
  }

  try {
    const { data: mcp } = await client.mcpServers.list();
    const have = new Set(mcp.map((m: { name: string }) => m.name));
    for (const name of referencedMcp) {
      if (!have.has(name)) console.warn(`! MCP server "${name}" is referenced but not configured in TrueForge`);
    }
  } catch {
    /* endpoint shape may differ; skip the check rather than fail the sync */
  }

  try {
    const { data: skills } = await client.skills.list();
    const have = new Set(skills.map((s: { name: string }) => s.name));
    for (const name of referencedSkills) {
      if (!have.has(name)) console.warn(`! skill "${name}" is referenced but not registered in TrueForge`);
    }
  } catch {
    /* skip */
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
