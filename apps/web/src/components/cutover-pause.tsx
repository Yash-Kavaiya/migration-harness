import type { PendingInteraction } from "@/lib/types";

function toolName(interaction: PendingInteraction): string {
  const payload = interaction.payload;
  if (payload && typeof payload === "object" && "toolCalls" in payload) {
    const calls = (payload as { toolCalls?: Array<{ name?: string }> }).toolCalls;
    return calls?.[0]?.name ?? "github-write";
  }
  return "github-write";
}

export function CutoverPause({
  interaction,
  demo,
  busy,
  onAllow,
  onDeny,
}: {
  interaction: PendingInteraction;
  demo: boolean;
  busy: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="overlay">
      <section className="panel hud-corners stack">
        <p className="kicker">Cutover checkpoint</p>
        <h2>TOOL APPROVAL REQUIRED</h2>
        <p>
          `mh-cutover` wants to run <b>{toolName(interaction)}</b>. The license authorized this hash. The
          write still pauses here.
        </p>
        {demo ? (
          <p className="badge demo">SIMULATED — demo mode does not write to GitHub or Daytona</p>
        ) : (
          <p className="badge live">LIVE GitHub write — this will open a real pull request</p>
        )}
        <div className="stack" style={{ gridTemplateColumns: "1fr 1fr", display: "grid" }}>
          <button className="btn" disabled={busy} onClick={onAllow} type="button">
            APPROVE WRITE
          </button>
          <button className="btn danger" disabled={busy} onClick={onDeny} type="button">
            DENY WRITE
          </button>
        </div>
      </section>
    </div>
  );
}
