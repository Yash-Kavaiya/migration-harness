import { loadConfig } from "./config.js";
import { DemoGateway } from "./demo-gateway.js";
import { Orchestrator } from "./orchestrator.js";
import { buildServer } from "./server.js";
import { SseHub } from "./sse.js";
import { makeStageResolver } from "./stages/resolver.js";
import { Store } from "./store.js";
import { TrueForgeGateway, type AgentGateway } from "./trueforge.js";

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env in cwd — use the ambient environment
  }

  const config = loadConfig();
  const store = new Store(config.ORCH_DB);
  const sse = new SseHub();
  const gateway: AgentGateway = config.MH_DEMO_MODE
    ? new DemoGateway()
    : new TrueForgeGateway(config);

  const orchestrator = new Orchestrator({
    store,
    gateway,
    sse,
    defaults: {
      sourceRepo: config.MH_SOURCE_REPO,
      sourcePath: config.MH_SOURCE_PATH,
      targetRepo: config.MH_TARGET_REPO,
      targetBranch: config.MH_TARGET_BRANCH,
    },
  });
  orchestrator.setStageResolver(makeStageResolver());
  await orchestrator.resumeIncomplete();

  const app = await buildServer({
    orchestrator,
    webOrigin: config.WEB_ORIGIN,
    mode: config.MH_DEMO_MODE ? "demo" : "live",
  });

  const shutdown = async (): Promise<void> => {
    sse.closeAll();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.ORCH_PORT, host: "0.0.0.0" });
  const runtime = config.MH_DEMO_MODE ? "credential-free demo" : `TrueForge: ${config.TRUEFORGE_BASE_URL}`;
  console.log(`orchestrator listening on :${config.ORCH_PORT} (${runtime})`);
}

void main();
