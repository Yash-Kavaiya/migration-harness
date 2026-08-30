import { canLicense } from "@/lib/timeline";
import type { MigrationView } from "@/lib/types";
import { GateGrid } from "./gate-grid";

export function LicenseCard({
  view,
  busy,
  error,
  onAllow,
  onDeny,
}: {
  view: MigrationView;
  busy: boolean;
  error: string | null;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const enabled = canLicense(view) && !busy;
  const sha = view.evidence.manifest?.manifestSha256 ?? "manifest not frozen";
  const anyRed = view.gates.some((gate) => gate.status === "fail");

  return (
    <section className="panel hud-corners license-card stack">
      <p className="kicker">Screen 04 · human license</p>
      <h2>LICENSE THE EXACT VERIFIED CHANGE</h2>
      <p className="muted">
        Everything is proven. Nothing has been written to the canonical repository. This is the stop.
      </p>
      <div className="grid-2">
        <div>
          <div className="kicker">Source</div>
          <div>
            {view.source.repo}@{view.source.commit.slice(0, 7)}
          </div>
          <div className="muted">{view.source.path}</div>
        </div>
        <div>
          <div className="kicker">Target</div>
          <div>
            {view.target.repo}:{view.target.branch}
          </div>
          <div className="muted">Rust / Axum</div>
        </div>
      </div>
      <GateGrid gates={view.gates} />
      <div>
        <div className="kicker">Manifest SHA-256</div>
        <div className="sha">{sha}</div>
      </div>
      {anyRed && <p className="fail">LICENSE MIGRATION stays disabled while any gate is red.</p>}
      {error && <p className="fail">{error}</p>}
      <div className="stack" style={{ gridTemplateColumns: "1fr 1fr", display: "grid" }}>
        <button className="btn" disabled={!enabled} onClick={onAllow} type="button">
          LICENSE MIGRATION
        </button>
        <button className="btn danger" disabled={busy} onClick={onDeny} type="button">
          DENY
        </button>
      </div>
    </section>
  );
}
