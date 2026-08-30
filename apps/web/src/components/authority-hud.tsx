import type { AuthorityPanel } from "@/lib/types";

const LOCK = {
  locked: { label: "LOCKED", className: "locked" },
  licensed: { label: "LICENSED", className: "licensed" },
  expired: { label: "CONSUMED", className: "locked" },
} as const;

export function AuthorityHud({ authority }: { authority: AuthorityPanel }) {
  const push = LOCK[authority.githubPush];
  return (
    <section className="panel screen stack">
      <div>
        <p className="kicker">Authority HUD</p>
        <h3>What this agent may do</h3>
      </div>
      <div className="authority">
        <div className={`auth-row ${authority.repoRead ? "granted" : "locked"}`}>
          <span>Repo Read</span>
          <b>{authority.repoRead ? "GRANTED" : "LOCKED"}</b>
        </div>
        <div className={`auth-row ${authority.sandbox ? "granted" : "locked"}`}>
          <span>Sandbox</span>
          <b>{authority.sandbox ? "GRANTED" : "LOCKED"}</b>
        </div>
        <div className={`auth-row ${authority.workspaceWrite ? "granted" : "locked"}`}>
          <span>Workspace Write</span>
          <b>{authority.workspaceWrite ? "GRANTED" : "LOCKED"}</b>
        </div>
        <div className={`auth-row ${push.className}`}>
          <span>GitHub Push</span>
          <b>{push.label}</b>
        </div>
        <div className="auth-row locked">
          <span>Merge</span>
          <b>LOCKED</b>
        </div>
      </div>
    </section>
  );
}
