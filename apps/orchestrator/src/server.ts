import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Orchestrator } from "./orchestrator.js";

const startBody = z.object({
  sourceRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  sourcePath: z.string().min(1),
  targetRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
  targetBranch: z.string().min(1).optional(),
});

const licenseBody = z.union([
  z.object({ decision: z.literal("allow"), decidedBy: z.string().min(1), reason: z.string().optional() }),
  z.object({ decision: z.literal("deny"), decidedBy: z.string().min(1), reason: z.string().optional() }),
]);

const answerBody = z.union([
  z.object({ kind: z.literal("approval"), status: z.literal("allow") }),
  z.object({ kind: z.literal("approval"), status: z.literal("deny"), reason: z.string().optional() }),
  z.object({ kind: z.literal("question"), content: z.string() }),
]);

export interface ServerDeps {
  orchestrator: Orchestrator;
  webOrigin: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: deps.webOrigin, credentials: true });

  const { orchestrator } = deps;

  app.get("/health", () => ({ status: "ok" }));

  app.post("/api/migrations", (req, reply) => {
    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return orchestrator.start(parsed.data);
  });

  app.get("/api/migrations/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    const view = orchestrator.view(id);
    return view ? view : reply.code(404).send({ error: "not found" });
  });

  app.get("/api/migrations/:id/events", (req, reply) => {
    const { id } = req.params as { id: string };
    if (!orchestrator.view(id)) return reply.code(404).send({ error: "not found" });

    const after = Number((req.query as { after?: string }).after ?? 0);
    reply.hijack();

    // Catch-up: replay persisted events the client missed, then attach to the live hub.
    const raw = reply.raw;
    const detach = orchestrator.attachStream(id, raw);
    for (const e of orchestrator.events(id, Number.isFinite(after) ? after : 0)) {
      raw.write(`id: ${e.seq}\nevent: persisted\ndata: ${JSON.stringify(e)}\n\n`);
    }
    req.raw.on("close", detach);
  });

  app.post("/api/migrations/:id/license", (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = licenseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = orchestrator.decideLicense(id, parsed.data);
    return result.ok ? { ok: true } : reply.code(409).send(result);
  });

  app.post("/api/migrations/:id/interaction/:eventId", (req, reply) => {
    const { eventId } = req.params as { eventId: string };
    const parsed = answerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = orchestrator.answerInteraction(eventId, parsed.data);
    return result.ok ? { ok: true } : reply.code(409).send(result);
  });

  app.post("/api/migrations/:id/freeze", (req, reply) => {
    const { id } = req.params as { id: string };
    const result = orchestrator.evaluateAndMaybeFreeze(id);
    return result.ok ? result : reply.code(409).send(result);
  });

  return app;
}
