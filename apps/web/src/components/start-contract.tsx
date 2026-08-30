"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getHealth, startMigration } from "@/lib/api";

const DEFAULTS = {
  sourceRepo: "acme/orderpricing-legacy",
  sourcePath: "src/OrderPricing.Api",
  sourceCommit: "d8091ab",
  targetRepo: "acme/orderpricing-legacy",
  targetBranch: "mh/orderpricing-rust",
};

export function StartContract() {
  const router = useRouter();
  const [demo, setDemo] = useState(true);
  const [orchMode, setOrchMode] = useState<"demo" | "live" | "unknown">("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(DEFAULTS);

  useEffect(() => {
    const stored = sessionStorage.getItem("mh.demo");
    if (stored === "0") setDemo(false);
    void getHealth()
      .then((health) => setOrchMode(health.mode))
      .catch(() => setOrchMode("unknown"));
  }, []);

  async function onStart(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    sessionStorage.setItem("mh.demo", demo ? "1" : "0");
    try {
      const { migrationId } = await startMigration({
        sourceRepo: form.sourceRepo.trim(),
        sourceCommit: form.sourceCommit.trim(),
        sourcePath: form.sourcePath.trim(),
        targetRepo: form.targetRepo.trim(),
        targetBranch: form.targetBranch.trim(),
      });
      router.push(`/m/${migrationId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="deck">
      <header className="topbar">
        <div className="brand">
          <b>MIGRATIONHARNESS</b>
          <span>control center</span>
        </div>
        <span className={`badge ${orchMode === "live" ? "live" : "demo"}`}>
          orchestrator {orchMode === "unknown" ? "unreachable" : orchMode}
        </span>
      </header>
      <main className="screen grid-2">
        <section className="stack">
          <p className="kicker">Screen 01 · contract</p>
          <h1>PROVE THE MIGRATION BEFORE YOU LICENSE THE CUTOVER.</h1>
          <p className="muted">
            Compilation proves Rust syntax. This control center proves behavior. Generated code does not
            earn authority. A human licenses a hash-bound, single-use manifest after the quality gates pass.
          </p>
          <p>
            Source: bounded .NET 8 API. Target: Rust / Axum. Cutover writes stay locked until a license is
            minted against the frozen manifest SHA.
          </p>
        </section>
        <form className="panel hud-corners screen stack" onSubmit={(event) => void onStart(event)}>
          <h2>START MIGRATION</h2>
          <div className="field">
            <label>Source repo</label>
            <input
              value={form.sourceRepo}
              onChange={(e) => setForm({ ...form, sourceRepo: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>Source path</label>
            <input
              value={form.sourcePath}
              onChange={(e) => setForm({ ...form, sourcePath: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>Source commit</label>
            <input
              value={form.sourceCommit}
              onChange={(e) => setForm({ ...form, sourceCommit: e.target.value })}
              required
              pattern="[0-9a-f]{7,40}"
            />
          </div>
          <div className="field">
            <label>Target</label>
            <input value="Rust / Axum" readOnly />
          </div>
          <div className="field">
            <label>Canonical repo / branch</label>
            <input
              value={`${form.targetRepo} : ${form.targetBranch}`}
              onChange={(e) => {
                const [repo, branch] = e.target.value.split(":");
                setForm({
                  ...form,
                  targetRepo: (repo ?? form.targetRepo).trim(),
                  targetBranch: (branch ?? form.targetBranch).trim(),
                });
              }}
            />
          </div>
          <div className="toggle">
            <div>
              <div className="kicker">Demo mode</div>
              <div className="muted">
                Default ON. Credential-free and simulated — no GitHub writes, no Daytona, no live MCP.
              </div>
            </div>
            <button
              type="button"
              className={demo ? "" : "off"}
              onClick={() => setDemo((value) => !value)}
            >
              {demo ? "ON" : "OFF"}
            </button>
          </div>
          {!demo && (
            <p className="warn">
              Live TrueForge requires `npx @truefoundry/trueforge`, GitHub tokens, and MH_DEMO_MODE=false.
            </p>
          )}
          {orchMode === "demo" && (
            <p className="muted">
              Orchestrator is in demo mode. Timeline events, sandbox cargo, and the cutover PR are simulated.
            </p>
          )}
          {error && <p className="fail">{error}</p>}
          <button className="btn" disabled={busy} type="submit">
            {busy ? "STARTING…" : "START MIGRATION"}
          </button>
        </form>
      </main>
      <footer className="footer">
        <span>WeMakeDevs × TrueForge Agent Harness Hackathon</span>
        <span>Repo read only until licensed</span>
      </footer>
    </div>
  );
}
