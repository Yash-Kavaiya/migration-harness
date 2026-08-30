export type MigrationStage =
  | "discover"
  | "contract"
  | "migrate"
  | "parity"
  | "repair"
  | "security"
  | "freeze"
  | "license"
  | "cutover"
  | "complete";

export type MigrationPhase =
  | "running"
  | "blocked"
  | "awaiting-license"
  | "complete"
  | "halted"
  | "denied"
  | "failed";

export interface MigrationTarget {
  repo: string;
  branch: string;
}

export interface MigrationSource {
  repo: string;
  commit: string;
  path: string;
}

export interface GateResult {
  id: string;
  n: number;
  title: string;
  status: "pass" | "fail" | "pending";
  detail: string;
}

export interface StageRun {
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

export interface PendingInteraction {
  eventId: string;
  sessionId: string;
  threadId: string;
  kind: "approval" | "question";
  payload: unknown;
  createdAt: string;
}

export interface AuthorityPanel {
  repoRead: boolean;
  sandbox: boolean;
  workspaceWrite: boolean;
  githubPush: "locked" | "licensed" | "expired";
  merge: "locked";
}

export interface ArchitectureEvidence {
  entrypoint?: string;
  endpoints: Array<{
    method: string;
    route: string;
    requestDto?: string | null;
    responseDto?: string | null;
    handler?: string;
  }>;
  components?: Array<{ name: string; riskClass: "GREEN" | "YELLOW" | "RED"; reason?: string }>;
  dependencies?: Array<{ name: string; version?: string; kind?: string }>;
  unsupported?: Array<{ component: string; reason: string }>;
  [key: string]: unknown;
}

export interface ContractEvidence {
  endpoints: Array<{
    method: string;
    route: string;
    request: Record<string, string>;
    response: Record<string, string>;
    invariants?: string[];
    compatibility: {
      statusCode: "exact";
      jsonFields: "exact" | "superset-allowed";
      decimalScale: number;
      nullSemantics?: "exact" | "lenient";
    };
  }>;
  [key: string]: unknown;
}

export interface BuildEvidence {
  cargoCheck: "PASS" | "FAIL";
  cargoTest: { passed: number; total: number };
  clippy: "PASS" | "FAIL";
  rustTree: Array<{ path: string; sha256: string }>;
  [key: string]: unknown;
}

export interface ParityMismatch {
  fixtureId: string;
  endpoint: { method: string; route: string };
  input: unknown;
  dotnet: unknown;
  rust: unknown;
  diff: Array<{ path: string; expected: unknown; actual: unknown }>;
  hypothesis?: string;
}

export interface ParityEvidence {
  migrationId?: string;
  rustCommitSha?: string;
  total: number;
  passed: number;
  failed: number;
  byRoute: Array<{ method: string; route: string; passed: number; total: number }>;
  mismatches: ParityMismatch[];
}

export interface SecurityEvidence {
  checks: Array<{ name: string; status: "pass" | "fail" | "skip"; detail?: string }>;
  newHighSeverity: number;
  [key: string]: unknown;
}

export interface ManifestEvidence {
  migrationId?: string;
  sourceRepo: string;
  sourceCommit: string;
  targetRepo: string;
  targetBranch: string;
  files: { created: number; modified: number; deleted: number };
  validation: {
    dotnetTests: string;
    rustTests: string;
    parity: string;
    clippy: "PASS" | "FAIL";
    security: "PASS" | "FAIL";
  };
  rustTreeSha256: string;
  manifestSha256: string;
  frozenAt?: string;
}

export interface MigrationEvidence {
  architecture: ArchitectureEvidence | null;
  contract: ContractEvidence | null;
  build: BuildEvidence | null;
  parity: ParityEvidence | null;
  parityDiagnosis: unknown | null;
  security: SecurityEvidence | null;
  manifest: ManifestEvidence | null;
  cutover: unknown | null;
}

export interface MigrationView {
  migrationId: string;
  source: MigrationSource;
  target: MigrationTarget;
  stage: MigrationStage;
  phase: MigrationPhase | string;
  repairRounds: number;
  terminal: boolean;
  licenseId: string | null;
  stages: StageRun[];
  gates: GateResult[];
  readyToFreeze: boolean;
  canCutover: boolean;
  authority: AuthorityPanel;
  pendingInteractions: PendingInteraction[];
  history: unknown[];
  evidence: MigrationEvidence;
}

export interface MigrationSummary {
  migrationId: string;
  source: MigrationSource;
  target: MigrationTarget;
  stage: MigrationStage;
  phase: string;
  repairRounds: number;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface HealthResponse {
  status: string;
  mode: "live" | "demo";
}

export interface StartMigrationInput {
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  targetRepo?: string;
  targetBranch?: string;
}

export type ControlState = "contract" | "live" | "parity" | "license" | "complete";
