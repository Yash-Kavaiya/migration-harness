export interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
  retry?: number;
}

export interface SseParser {
  feed(chunk: string): void;
  end(): void;
}

export interface SseSubscriptionOptions {
  url: string;
  after?: number;
  signal: AbortSignal;
  onMessage: (event: SseEvent) => void;
  onStateChange?: (state: "connecting" | "open" | "reconnecting" | "closed") => void;
  onError?: (error: Error) => void;
  fetchImpl?: typeof fetch;
  minRetryMs?: number;
  maxRetryMs?: number;
}

export function createSseParser(
  onEvent: (event: SseEvent) => void,
  onRetry?: (milliseconds: number) => void,
): SseParser {
  let buffer = "";
  let lastEventId: string | undefined;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let retry: number | undefined;

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = undefined;
      retry = undefined;
      return;
    }
    onEvent({
      ...(lastEventId !== undefined ? { id: lastEventId } : {}),
      event: eventName || "message",
      data: dataLines.join("\n"),
      ...(retry !== undefined ? { retry } : {}),
    });
    eventName = undefined;
    dataLines = [];
    retry = undefined;
  };

  const processLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
    else if (field === "retry" && /^\d+$/.test(value)) {
      retry = Number(value);
      onRetry?.(retry);
    }
  };

  return {
    feed(chunk: string): void {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        newline = buffer.indexOf("\n");
      }
    },
    end(): void {
      if (buffer.length > 0) {
        processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

export function withReconnectCursor(url: string, after: number): string {
  const next = new URL(url);
  next.searchParams.set("after", String(after));
  return next.toString();
}

export async function subscribeToSse(options: SseSubscriptionOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const minRetryMs = options.minRetryMs ?? 750;
  const maxRetryMs = options.maxRetryMs ?? 8_000;
  let cursor = options.after ?? 0;
  let retryMs = minRetryMs;
  let attempt = 0;

  options.onStateChange?.("connecting");

  while (!options.signal.aborted) {
    try {
      const response = await fetchImpl(withReconnectCursor(options.url, cursor), {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        credentials: "include",
        cache: "no-store",
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`Event stream returned ${response.status} ${response.statusText}`.trim());
      if (!response.body) throw new Error("Event stream response has no readable body");

      options.onStateChange?.("open");
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser(
        (rawEvent) => {
          const numericId = Number(rawEvent.id);
          if (Number.isSafeInteger(numericId) && numericId > cursor) cursor = numericId;
          options.onMessage({ ...rawEvent, data: parseEventData(rawEvent.data) });
        },
        (serverRetryMs) => {
          retryMs = Math.max(minRetryMs, Math.min(maxRetryMs, serverRetryMs));
        },
      );

      while (!options.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.end();
      if (options.signal.aborted) break;
      throw new Error("Event stream disconnected");
    } catch (error) {
      if (options.signal.aborted) break;
      const normalized = error instanceof Error ? error : new Error(String(error));
      options.onError?.(normalized);
      options.onStateChange?.("reconnecting");
      const backoff = Math.min(maxRetryMs, retryMs * 2 ** attempt);
      attempt += 1;
      await abortableDelay(backoff, options.signal);
    }
  }

  options.onStateChange?.("closed");
}

function parseEventData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
