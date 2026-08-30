import { classifyTimelineEvent } from "@/lib/timeline";
import type { TimelineEvent } from "@/lib/types";

export function AgentTimeline({ events, demo }: { events: TimelineEvent[]; demo: boolean }) {
  const newestFirst = [...events].reverse();
  return (
    <section className="panel screen stack">
      <div>
        <p className="kicker">TrueForge events</p>
        <h3>Agent timeline</h3>
      </div>
      <div className="timeline">
        {newestFirst.length === 0 && <p className="muted">Waiting for the first turn…</p>}
        {newestFirst.map((event) => {
          const classified = classifyTimelineEvent(event);
          return (
            <article key={event.seq} className={`event ${classified.kind}`}>
              <div className="kind">#{event.seq}</div>
              <div>
                <div className="title">{classified.title}</div>
                <div className="detail">
                  {classified.detail}
                  {(demo || classified.simulated) && classified.kind !== "state" ? " · simulated" : ""}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
