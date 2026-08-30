import { simulatedPullRequestUrl } from "@/lib/timeline";
import type { MigrationView, TimelineEvent } from "@/lib/types";
import { AgentTimeline } from "./agent-timeline";
import { AuthorityHud } from "./authority-hud";

export function CompletePanel({
  view,
  events,
  demo,
}: {
  view: MigrationView;
  events: TimelineEvent[];
  demo: boolean;
}) {
  const cutover = view.evidence.cutover as { pullRequestUrl?: string | null } | null;
  const url =
    cutover?.pullRequestUrl ||
    (demo ? simulatedPullRequestUrl(view.target.repo, view.migrationId) : "");

  return (
    <section className="stack">
      <p className="kicker">Screen 05 · complete</p>
      <h2>ONE HUMAN DECISION, BOUND TO ONE HASH, SPENT ONCE.</h2>
      <div className="grid-2">
        <div className="panel screen stack">
          <div>
            <div className="kicker">Pull request</div>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            ) : (
              <span className="muted">No pull request URL recorded.</span>
            )}
            {demo && <div className="badge demo">placeholder URL · simulated cutover</div>}
          </div>
          <div>
            <div className="kicker">License</div>
            <div className="pass">Consumed ✓ {view.licenseId ?? ""}</div>
            <div className="muted">uses remaining: 0</div>
          </div>
          <div>
            <div className="kicker">Manifest</div>
            <div className="sha">{view.evidence.manifest?.manifestSha256 ?? "—"}</div>
          </div>
        </div>
        <AuthorityHud authority={view.authority} />
      </div>
      <AgentTimeline events={events} demo={demo} />
    </section>
  );
}
