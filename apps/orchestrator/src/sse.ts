import type { ServerResponse } from "node:http";

/**
 * One event stream per migration, fanned out to every connected UI. Events are
 * also persisted (see Store.appendEvent) so a reconnecting client can catch up
 * via `GET /api/migrations/:id/events?after=<seq>` before attaching here.
 */
export interface SseMessage {
  /** Monotonic per-migration sequence — the client sends the last one it saw on reconnect. */
  seq: number;
  event: string;
  data: unknown;
}

interface Client {
  res: ServerResponse;
  close: () => void;
}

export class SseHub {
  private readonly rooms = new Map<string, Set<Client>>();

  subscribe(migrationId: string, res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const client: Client = { res, close: () => this.unsubscribe(migrationId, client) };
    const room = this.rooms.get(migrationId) ?? new Set<Client>();
    room.add(client);
    this.rooms.set(migrationId, room);

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        client.close();
      }
    }, 15_000);

    const done = (): void => {
      clearInterval(heartbeat);
      this.unsubscribe(migrationId, client);
    };
    res.on("close", done);
    res.on("error", done);
    return done;
  }

  private unsubscribe(migrationId: string, client: Client): void {
    const room = this.rooms.get(migrationId);
    if (!room) return;
    room.delete(client);
    if (room.size === 0) this.rooms.delete(migrationId);
  }

  broadcast(migrationId: string, message: SseMessage): void {
    const room = this.rooms.get(migrationId);
    if (!room) return;
    const frame = `id: ${message.seq}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
    for (const client of room) {
      try {
        client.res.write(frame);
      } catch {
        client.close();
      }
    }
  }

  connectionCount(migrationId: string): number {
    return this.rooms.get(migrationId)?.size ?? 0;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      for (const client of room) {
        try {
          client.res.end();
        } catch {
          /* already gone */
        }
      }
    }
    this.rooms.clear();
  }
}
