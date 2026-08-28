import { z } from "zod";

const schema = z.object({
  ORCH_PORT: z.coerce.number().int().positive().default(8080),
  ORCH_DB: z.string().default("./apps/orchestrator/data/mh.sqlite"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),

  TRUEFORGE_BASE_URL: z.string().url().default("http://localhost:8790"),
  TRUEFORGE_API_KEY: z.string().min(1).optional(),

  // Defaults for a migration when the request omits them.
  MH_SOURCE_REPO: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  MH_SOURCE_PATH: z.string().optional(),
  MH_TARGET_REPO: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  MH_TARGET_BRANCH: z.string().default("main"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid orchestrator configuration:\n${issues}`);
  }
  return parsed.data;
}
