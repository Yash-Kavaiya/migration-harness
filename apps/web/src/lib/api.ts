export const ORCH_URL = process.env.NEXT_PUBLIC_ORCH_URL ?? "http://localhost:8080";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ORCH_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "reason" in body && (body as { reason?: unknown }).reason
        ? String((body as { reason: unknown }).reason)
        : body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export function getHealth() {
  return request<{ status: string; mode: "live" | "demo" }>("/health");
}

export function startMigration(input: {
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  targetRepo?: string;
  targetBranch?: string;
}) {
  return request<{ migrationId: string }>("/api/migrations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getMigration<T>(id: string) {
  return request<T>(`/api/migrations/${encodeURIComponent(id)}`);
}

export function freezeMigration(id: string) {
  return request<{ ok: boolean; readyToFreeze: boolean; reason?: string }>(
    `/api/migrations/${encodeURIComponent(id)}/freeze`,
    { method: "POST" },
  );
}

export function decideLicense(
  id: string,
  body: { decision: "allow" | "deny"; decidedBy: string; reason?: string },
) {
  return request<{ ok: boolean; licenseId?: string; reason?: string }>(
    `/api/migrations/${encodeURIComponent(id)}/license`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function answerInteraction(
  id: string,
  eventId: string,
  body:
    | { kind: "approval"; status: "allow" }
    | { kind: "approval"; status: "deny"; reason?: string }
    | { kind: "question"; content: string },
) {
  return request<{ ok: boolean; reason?: string }>(
    `/api/migrations/${encodeURIComponent(id)}/interaction/${encodeURIComponent(eventId)}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function eventsUrl(id: string): string {
  return `${ORCH_URL}/api/migrations/${encodeURIComponent(id)}/events`;
}
