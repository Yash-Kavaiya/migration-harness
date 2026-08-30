import { describe, expect, it } from "vitest";
import { createSseParser, withReconnectCursor } from "./sse";

describe("createSseParser", () => {
  it("parses chunked CRLF frames, comments and multi-line data", () => {
    const received: unknown[] = [];
    const parser = createSseParser((event) => received.push(event));

    parser.feed(": heartbeat\r\nid: 17\r\nevent: tf.item\r\ndata: {\"line\":1}\r\ndata:");
    parser.feed(" {\"line\":2}\r\nretry: 2500\r\n\r\n");

    expect(received).toEqual([
      {
        id: "17",
        event: "tf.item",
        data: '{"line":1}\n{"line":2}',
        retry: 2500,
      },
    ]);
  });

  it("carries the last event id across frames and ignores invalid retry values", () => {
    const received: unknown[] = [];
    const parser = createSseParser((event) => received.push(event));

    parser.feed("id: 8\ndata: first\n\nretry: later\ndata: second\n\n");

    expect(received).toEqual([
      { id: "8", event: "message", data: "first" },
      { id: "8", event: "message", data: "second" },
    ]);
  });

  it("flushes a final unterminated event when the stream closes", () => {
    const received: unknown[] = [];
    const parser = createSseParser((event) => received.push(event));

    parser.feed("event: final\ndata: done");
    parser.end();

    expect(received).toEqual([{ event: "final", data: "done" }]);
  });
});

describe("withReconnectCursor", () => {
  it("adds and replaces the after cursor without losing other query params", () => {
    expect(withReconnectCursor("http://localhost:8080/events?scope=all&after=2", 19)).toBe(
      "http://localhost:8080/events?scope=all&after=19",
    );
  });
});
