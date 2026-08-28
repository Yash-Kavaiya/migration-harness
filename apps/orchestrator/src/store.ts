import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  MigrationLicense,
  MigrationPhase,
  MigrationStage,
  MigrationState,
  StageOutcome,
  StageTransition,
} from "@mh/shared";

export interface MigrationRow {
  id: string;
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  targetRepo: string;
  targetBranch: string;
  stage: MigrationStage;
  phase: MigrationPhase;
  repairRounds: number;
  licenseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StageRunRow {
  id: number;
  migrationId: string;
  stage: MigrationStage;
  agent: string | null;
  sessionId: string | null;
  turnId: string | null;
  status: "running" | "done" | "error" | "waiting";
  lastSeq: number;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StoredEvent {
  seq: number;
  migrationId: string;
  sessionId: string | null;
  type: string;
  payload: unknown;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  id            TEXT PRIMARY KEY,
  source_repo   TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  target_repo   TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  stage         TEXT NOT NULL,
  phase         TEXT NOT NULL,
  repair_rounds INTEGER NOT NULL DEFAULT 0,
  license_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transitions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id TEXT NOT NULL REFERENCES migrations(id),
  from_stage   TEXT NOT NULL,
  to_stage     TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id TEXT NOT NULL REFERENCES migrations(id),
  stage        TEXT NOT NULL,
  agent        TEXT,
  session_id   TEXT,
  turn_id      TEXT,
  status       TEXT NOT NULL,
  last_seq     INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id TEXT NOT NULL REFERENCES migrations(id),
  session_id   TEXT,
  tf_seq       INTEGER,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_migration ON events (migration_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  migration_id TEXT NOT NULL REFERENCES migrations(id),
  kind         TEXT NOT NULL,
  json         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (migration_id, kind)
);

CREATE TABLE IF NOT EXISTS licenses (
  license_id   TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES migrations(id),
  json         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_interactions (
  event_id     TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES migrations(id),
  session_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);
`;

// `node:sqlite` is a recent built-in; loaded via require() so bundler resolvers
// that don't yet recognize the specifier leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Row = Record<string, unknown>;

function toMigrationRow(r: Row): MigrationRow {
  return {
    id: r.id as string,
    sourceRepo: r.source_repo as string,
    sourceCommit: r.source_commit as string,
    sourcePath: r.source_path as string,
    targetRepo: r.target_repo as string,
    targetBranch: r.target_branch as string,
    stage: r.stage as MigrationStage,
    phase: r.phase as MigrationPhase,
    repairRounds: Number(r.repair_rounds),
    licenseId: (r.license_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export interface CreateMigrationInput {
  id: string;
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  targetRepo: string;
  targetBranch: string;
  at: string;
}

export class Store {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- migrations -----------------------------------------------------------

  createMigration(input: CreateMigrationInput): MigrationRow {
    this.db
      .prepare(
        `INSERT INTO migrations
           (id, source_repo, source_commit, source_path, target_repo, target_branch,
            stage, phase, repair_rounds, license_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'discover', 'running', 0, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceRepo,
        input.sourceCommit,
        input.sourcePath,
        input.targetRepo,
        input.targetBranch,
        input.at,
        input.at,
      );
    return this.getMigration(input.id)!;
  }

  getMigration(id: string): MigrationRow | null {
    const r = this.db.prepare("SELECT * FROM migrations WHERE id = ?").get(id) as Row | undefined;
    return r ? toMigrationRow(r) : null;
  }

  listMigrations(): MigrationRow[] {
    return (this.db.prepare("SELECT * FROM migrations ORDER BY created_at DESC").all() as Row[]).map(
      toMigrationRow,
    );
  }

  /** Persist a state-machine snapshot: the scalar fields, plus any new transitions. */
  saveState(migrationId: string, state: MigrationState, at: string): void {
    this.db
      .prepare(
        `UPDATE migrations
            SET stage = ?, phase = ?, repair_rounds = ?, license_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(state.stage, state.phase, state.repairRounds, state.licenseId, at, migrationId);

    const known = Number(
      (this.db
        .prepare("SELECT COUNT(*) AS n FROM transitions WHERE migration_id = ?")
        .get(migrationId) as Row).n,
    );
    for (const t of state.history.slice(known)) {
      this.db
        .prepare(
          `INSERT INTO transitions (migration_id, from_stage, to_stage, outcome, at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(migrationId, t.from, t.to, t.outcome, t.at);
    }
  }

  /** Rebuild the state-machine value object from what's persisted. */
  loadState(migrationId: string): MigrationState | null {
    const m = this.getMigration(migrationId);
    if (!m) return null;
    const history = (
      this.db
        .prepare("SELECT * FROM transitions WHERE migration_id = ? ORDER BY id ASC")
        .all(migrationId) as Row[]
    ).map(
      (r): StageTransition => ({
        from: r.from_stage as MigrationStage,
        to: r.to_stage as MigrationStage,
        outcome: r.outcome as StageOutcome,
        at: r.at as string,
      }),
    );
    return {
      migrationId,
      stage: m.stage,
      phase: m.phase,
      repairRounds: m.repairRounds,
      licenseId: m.licenseId,
      history,
    };
  }

  // ---- stage runs ----------------------------------------------------------

  startStageRun(
    migrationId: string,
    stage: MigrationStage,
    agent: string | null,
    at: string,
  ): number {
    const res = this.db
      .prepare(
        `INSERT INTO stage_runs (migration_id, stage, agent, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(migrationId, stage, agent, at);
    return Number(res.lastInsertRowid);
  }

  attachSession(runId: number, sessionId: string, turnId: string | null): void {
    this.db
      .prepare("UPDATE stage_runs SET session_id = ?, turn_id = ? WHERE id = ?")
      .run(sessionId, turnId, runId);
  }

  updateStageRun(
    runId: number,
    patch: { status?: StageRunRow["status"]; lastSeq?: number; detail?: string; finishedAt?: string },
  ): void {
    const sets: string[] = [];
    const vals: Array<string | number> = [];
    if (patch.status !== undefined) (sets.push("status = ?"), vals.push(patch.status));
    if (patch.lastSeq !== undefined) (sets.push("last_seq = ?"), vals.push(patch.lastSeq));
    if (patch.detail !== undefined) (sets.push("detail = ?"), vals.push(patch.detail));
    if (patch.finishedAt !== undefined) (sets.push("finished_at = ?"), vals.push(patch.finishedAt));
    if (sets.length === 0) return;
    vals.push(runId);
    this.db.prepare(`UPDATE stage_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  stageRuns(migrationId: string): StageRunRow[] {
    return (
      this.db
        .prepare("SELECT * FROM stage_runs WHERE migration_id = ? ORDER BY id ASC")
        .all(migrationId) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      migrationId: r.migration_id as string,
      stage: r.stage as MigrationStage,
      agent: (r.agent as string | null) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      turnId: (r.turn_id as string | null) ?? null,
      status: r.status as StageRunRow["status"],
      lastSeq: Number(r.last_seq),
      detail: (r.detail as string | null) ?? null,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
    }));
  }

  // ---- events ------------------------------------------------------------

  appendEvent(
    migrationId: string,
    sessionId: string | null,
    tfSeq: number | null,
    type: string,
    payload: unknown,
    at: string,
  ): number {
    const res = this.db
      .prepare(
        `INSERT INTO events (migration_id, session_id, tf_seq, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(migrationId, sessionId, tfSeq, type, JSON.stringify(payload), at);
    return Number(res.lastInsertRowid);
  }

  events(migrationId: string, afterSeq = 0): StoredEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE migration_id = ? AND seq > ? ORDER BY seq ASC")
        .all(migrationId, afterSeq) as Row[]
    ).map((r) => ({
      seq: Number(r.seq),
      migrationId: r.migration_id as string,
      sessionId: (r.session_id as string | null) ?? null,
      type: r.type as string,
      payload: JSON.parse(r.payload as string) as unknown,
      createdAt: r.created_at as string,
    }));
  }

  // ---- artifacts --------------------------------------------------------

  putArtifact(migrationId: string, kind: string, value: unknown, at: string): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (migration_id, kind, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (migration_id, kind) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
      )
      .run(migrationId, kind, JSON.stringify(value), at);
  }

  getArtifact<T = unknown>(migrationId: string, kind: string): T | null {
    const r = this.db
      .prepare("SELECT json FROM artifacts WHERE migration_id = ? AND kind = ?")
      .get(migrationId, kind) as Row | undefined;
    return r ? (JSON.parse(r.json as string) as T) : null;
  }

  // ---- licenses -------------------------------------------------------

  putLicense(license: MigrationLicense, at: string): void {
    this.db
      .prepare(
        `INSERT INTO licenses (license_id, migration_id, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (license_id) DO UPDATE SET json = excluded.json`,
      )
      .run(license.licenseId, license.migrationId, JSON.stringify(license), at);
  }

  getLicense(migrationId: string): MigrationLicense | null {
    const r = this.db
      .prepare("SELECT json FROM licenses WHERE migration_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(migrationId) as Row | undefined;
    return r ? (JSON.parse(r.json as string) as MigrationLicense) : null;
  }

  // ---- pending interactions -----------------------------------------

  putPendingInteraction(i: {
    eventId: string;
    migrationId: string;
    sessionId: string;
    threadId: string;
    kind: "approval" | "question";
    payload: unknown;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_interactions
           (event_id, migration_id, session_id, thread_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id) DO NOTHING`,
      )
      .run(i.eventId, i.migrationId, i.sessionId, i.threadId, i.kind, JSON.stringify(i.payload), i.at);
  }

  resolvePendingInteraction(eventId: string, at: string): void {
    this.db.prepare("UPDATE pending_interactions SET resolved_at = ? WHERE event_id = ?").run(at, eventId);
  }

  openInteractions(migrationId: string): Array<{
    eventId: string;
    sessionId: string;
    threadId: string;
    kind: "approval" | "question";
    payload: unknown;
    createdAt: string;
  }> {
    return (
      this.db
        .prepare(
          "SELECT * FROM pending_interactions WHERE migration_id = ? AND resolved_at IS NULL ORDER BY created_at ASC",
        )
        .all(migrationId) as Row[]
    ).map((r) => ({
      eventId: r.event_id as string,
      sessionId: r.session_id as string,
      threadId: r.thread_id as string,
      kind: r.kind as "approval" | "question",
      payload: JSON.parse(r.payload as string) as unknown,
      createdAt: r.created_at as string,
    }));
  }

  pendingInteraction(eventId: string): {
    eventId: string;
    migrationId: string;
    sessionId: string;
    threadId: string;
    kind: "approval" | "question";
    payload: unknown;
    resolvedAt: string | null;
  } | null {
    const r = this.db
      .prepare("SELECT * FROM pending_interactions WHERE event_id = ?")
      .get(eventId) as Row | undefined;
    if (!r) return null;
    return {
      eventId: r.event_id as string,
      migrationId: r.migration_id as string,
      sessionId: r.session_id as string,
      threadId: r.thread_id as string,
      kind: r.kind as "approval" | "question",
      payload: JSON.parse(r.payload as string) as unknown,
      resolvedAt: (r.resolved_at as string | null) ?? null,
    };
  }
}
