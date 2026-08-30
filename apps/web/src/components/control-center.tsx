"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveControlState,
  deriveOperationalSummary,
  derivePipeline,
  normalizeStreamEvent,
} from "@/lib/model";
import {
  answerInteraction,
  decideLicense,
  eventsUrl,
  freezeMigration,
  getHealth,
  getMigration,
} from "@/lib/api";
import { subscribeToSse } from "@/lib/sse";
import type { MigrationView, PendingInteraction, TimelineEvent } from "@/lib/types";
import { AgentTimeline } from "./agent-timeline";
import { AuthorityHud } from "./authority-hud";
import { CompletePanel } from "./complete-panel";
import { CutoverPause } from "./cutover-pause";
import { GateGrid } from "./gate-grid";
import { LicenseCard } from "./license-card";
import { ParityInspector } from "./parity-inspector";
import { PipelineRail } from "./pipeline-rail";

const OPERATOR = "operator@local";

export function ControlCenter({ migrationId }: { migrationId: string }) {
  const [view, setView] = useState<MigrationView | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [stream, setStream] = useState<"connecting" | "open" | "reconnecting" | "closed">("connecting");
  const [demo, setDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const freezeOnce = useRef(false);
  const cursor = useRef(0);

  const refresh = useCallback(async () => {
    const next = await getMigration<MigrationView>(migrationId);
    setView(next);
    return next;
  }, [migrationId]);

  useEffect(() => {
    const stored = sessionStorage.getItem("mh.demo");
    if (stored === "0") setDemo(false);
    void getHealth()
      .then((health) => {
        if (health.mode === "demo") setDemo(true);
        else if (health.mode === "live") setDemo(false);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void subscribeToSse({
      url: eventsUrl(migrationId),
      after: cursor.current,
      signal: controller.signal,
      onStateChange: setStream,
      onMessage: (frame) => {
        const normalized = normalizeStreamEvent(frame);
        if (normalized) {
          cursor.current = Math.max(cursor.current, normalized.seq);
          setEvents((current) => {
            if (current.some((item) => item.seq === normalized.seq)) return current;
            return [...current, normalized].sort((a, b) => a.seq - b.seq);
          });
        }
        if (
          frame.event === "state" ||
          frame.event === "persisted" ||
          frame.event.startsWith("license.") ||
          frame.event === "interaction.required" ||
          frame.event === "cutover.checkpoint" ||
          frame.event === "manifest.frozen"
        ) {
          void refresh();
        }
      },
    });
    return () => controller.abort();
  }, [migrationId, refresh]);

  useEffect(() => {
    if (!view || freezeOnce.current) return;
    if (view.stage === "freeze" && view.readyToFreeze) {
      freezeOnce.current = true;
      void freezeMigration(migrationId)
        .then(() => refresh())
        .catch((err: unknown) => {
          freezeOnce.current = false;
          setError(err instanceof Error ? err.message : String(err));
        });
    }
  }, [migrationId, refresh, view]);

  const screen = deriveControlState(view);
  const pipeline = view ? derivePipeline(view) : [];
  const summary = view ? deriveOperationalSummary(view) : null;
  const pending = useMemo(() => {
    const open = view?.pendingInteractions ?? [];
    return open.find((item) => item.kind === "approval") ?? null;
  }, [view]);

  async function license(decision: "allow" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await decideLicense(migrationId, { decision, decidedBy: OPERATOR });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function answer(interaction: PendingInteraction, status: "allow" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await answerInteraction(migrationId, interaction.eventId, { kind: "approval", status });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="deck">
      <header className="topbar">
        <div className="brand">
          <b>MIGRATIONHARNESS</b>
          <span>{migrationId}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {stream !== "open" && <span className="reconnect">SSE {stream} · reconnecting from cursor {cursor.current}</span>}
          <span className={`badge ${demo ? "demo" : "live"}`}>{demo ? "demo simulated" : "live trueforge"}</span>
        </div>
      </header>
      <main className="screen stack">
        {view && <PipelineRail steps={pipeline} />}
        {summary && (
          <p className="muted">
            {summary.activity} · {summary.proof} · {summary.authority}
          </p>
        )}
        {error && <p className="fail">{error}</p>}
        {!view && <p className="muted">Loading migration {migrationId}…</p>}
        {view && screen === "license" && (
          <LicenseCard
            view={view}
            busy={busy}
            error={error}
            onAllow={() => void license("allow")}
            onDeny={() => void license("deny")}
          />
        )}
        {view && screen === "complete" && <CompletePanel view={view} events={events} demo={demo} />}
        {view && (screen === "live" || screen === "parity") && (
          <div className="grid-3">
            <AgentTimeline events={events} demo={demo} />
            <div className="stack">
              <AuthorityHud authority={view.authority} />
              <GateGrid gates={view.gates} />
            </div>
            <ParityInspector parity={view.evidence.parity} repairRounds={view.repairRounds} />
          </div>
        )}
      </main>
      {pending && view?.stage === "cutover" && (
        <CutoverPause
          interaction={pending}
          demo={demo}
          busy={busy}
          onAllow={() => void answer(pending, "allow")}
          onDeny={() => void answer(pending, "deny")}
        />
      )}
      <footer className="footer">
        <span>{demo ? "DemoGateway is simulated. No GitHub write. No Daytona." : "Live TrueForge session"}</span>
        <span>GitHub push locked until licensed · merge never granted</span>
      </footer>
    </div>
  );
}
