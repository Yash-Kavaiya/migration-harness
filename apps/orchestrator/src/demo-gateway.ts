import type {
  AgentGateway,
  ReplyParams,
  ResumeParams,
  RunStageParams,
  StageEvent,
  StageResult,
} from "./trueforge.js";

interface DemoCall {
  method: "runStage" | "resume" | "reply" | "downloadArtifact";
  agentName?: string;
  input?: string;
}

interface DemoInput {
  migrationId: string;
  sourceRepo?: string;
  sourceCommit?: string;
  sourcePath?: string;
}

export interface DemoGatewayOptions {
  /** Visual pacing for the control-center demo. Tests leave this at 0. */
  stepDelayMs?: number;
}

const ENDPOINTS = [
  { method: "GET", route: "/health" },
  { method: "GET", route: "/rules" },
  { method: "POST", route: "/quote" },
  { method: "POST", route: "/discount" },
  { method: "POST", route: "/shipping" },
] as const;

const RUST_TREE = [
  { path: "Cargo.toml", sha256: "a".repeat(64) },
  { path: "src/main.rs", sha256: "b".repeat(64) },
  { path: "src/pricing.rs", sha256: "c".repeat(64) },
  { path: "tests/contract.rs", sha256: "d".repeat(64) },
];

function json(value: unknown): string {
  return JSON.stringify(value);
}

function contractEndpoint(method: (typeof ENDPOINTS)[number]["method"], route: string) {
  return {
    method,
    route,
    request: method === "GET" ? {} : { body: "JSON object" },
    response: { body: "JSON object" },
    invariants: route === "/quote" ? ["total >= 0", "discount <= subtotal"] : [],
    compatibility: {
      statusCode: "exact" as const,
      jsonFields: "exact" as const,
      decimalScale: 2,
      nullSemantics: "exact" as const,
    },
  };
}

/**
 * Credential-free, deterministic showcase of the complete orchestration path.
 * It never reaches GitHub or executes generated code; the UI labels this mode as
 * simulated. Production mode continues to use TrueForgeGateway.
 */
export class DemoGateway implements AgentGateway {
  readonly calls: DemoCall[] = [];
  private sequence = 0;
  private sessionSequence = 0;
  private readonly parityRuns = new Map<string, number>();
  private readonly artifactsBySession = new Map<string, Record<string, string>>();
  private readonly stepDelayMs: number;

  constructor(options: DemoGatewayOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 0;
  }

  async runStage(params: RunStageParams): Promise<StageResult> {
    this.calls.push({ method: "runStage", agentName: params.agentName, input: params.input });
    const input = this.parseInput(params.input);
    const sessionId = `demo-session-${++this.sessionSequence}`;
    const turnId = `demo-turn-${this.sessionSequence}`;
    params.onStart?.({ sessionId });
    this.artifactsBySession.set(sessionId, this.artifacts(params.agentName, input));

    await this.emit(params.onEvent, "turn.created", {
      type: "turn.created",
      turnId,
      state: { status: "running" },
      simulated: true,
    });
    await this.pause();

    for (const tool of this.tools(params.agentName, input.migrationId)) {
      await this.emit(params.onEvent, "tool.call", {
        type: "tool.call",
        name: tool.name,
        content: tool.detail,
        simulated: true,
      });
      await this.pause();
      await this.emit(params.onEvent, "tool.result", {
        type: "tool.result",
        name: tool.name,
        content: tool.result,
        simulated: true,
      });
      await this.pause();
    }

    await this.emit(params.onEvent, "model.message", {
      type: "model.message",
      content: this.activity(params.agentName, input.migrationId),
      simulated: true,
    });

    if (params.agentName === "mh-cutover") {
      await this.emit(params.onEvent, "tool.approval_required", {
        type: "tool.approval_required",
        threadId: "main",
        simulated: true,
        toolCalls: [{ id: `demo-pr-${input.migrationId}`, name: "create_pull_request" }],
      });
      return { sessionId, turnId, lastSeq: this.sequence, outcome: "waiting" };
    }

    await this.emit(params.onEvent, "turn.done", {
      type: "turn.done",
      state: { status: "done" },
      simulated: true,
    });
    return { sessionId, turnId, lastSeq: this.sequence, outcome: "completed" };
  }

  async resume(params: ResumeParams): Promise<StageResult> {
    this.calls.push({ method: "resume" });
    await this.emit(params.onEvent, "turn.done", {
      type: "turn.done",
      state: { status: "done" },
      simulated: true,
    });
    return {
      sessionId: params.sessionId,
      turnId: params.turnId,
      lastSeq: this.sequence,
      outcome: "completed",
    };
  }

  async reply(params: ReplyParams): Promise<StageResult> {
    this.calls.push({ method: "reply" });
    await this.emit(params.onEvent, "tool.response", {
      type: "tool.response",
      threadId: "main",
      simulated: true,
      content: "Demo PR opened (no external write was performed).",
    });
    await this.emit(params.onEvent, "turn.done", {
      type: "turn.done",
      state: { status: "done" },
      simulated: true,
    });
    return {
      sessionId: params.sessionId,
      turnId: params.turnId,
      lastSeq: this.sequence,
      outcome: "completed",
    };
  }

  async downloadArtifact(params: {
    sessionId: string;
    turnId: string;
    path: string;
  }): Promise<string> {
    this.calls.push({ method: "downloadArtifact", input: params.path });
    return this.artifactsBySession.get(params.sessionId)?.[params.path] ?? "{}";
  }

  private tools(agentName: string, migrationId: string): Array<{ name: string; detail: string; result: string }> {
    if (agentName === "mh-architect" || agentName === "mh-contract") {
      return [
        {
          name: "github-read.get_file_contents",
          detail: "src/OrderPricing.Api/Program.cs",
          result: "read 5 endpoints from orderpricing-legacy (simulated MCP)",
        },
      ];
    }
    if (agentName === "mh-migrator") {
      return [
        {
          name: "sandbox.exec",
          detail: "cargo check --offline",
          result: "PASS (simulated sandbox; no Daytona)",
        },
        {
          name: "sandbox.exec",
          detail: "cargo test --offline",
          result: "41/41 passed (simulated sandbox; no Daytona)",
        },
      ];
    }
    if (agentName === "mh-parity") {
      const run = this.parityRuns.get(migrationId) ?? 0;
      return [
        {
          name: "sandbox.exec",
          detail: "replay fixtures/fixtures.json against generated Axum",
          result:
            run <= 1
              ? "383/384 — fx-0184 total 170.00 vs 169.99 (simulated)"
              : "384/384 behavioral parity clean (simulated)",
        },
      ];
    }
    if (agentName === "mh-repair") {
      return [
        {
          name: "sandbox.exec",
          detail: "patch money path to rust_decimal::Decimal",
          result: "midpoint-to-even rounding restored (simulated)",
        },
      ];
    }
    if (agentName === "mh-security") {
      return [
        {
          name: "sandbox.exec",
          detail: "cargo audit --offline",
          result: "zero new high-severity (simulated)",
        },
      ];
    }
    return [];
  }

  private artifacts(agentName: string, input: DemoInput): Record<string, string> {
    const migrationId = input.migrationId;
    if (agentName === "mh-architect") {
      return {
        "architecture.json": json({
          migrationId,
          sourceRepo: input.sourceRepo ?? "demo/orderpricing-legacy",
          sourceCommit: input.sourceCommit ?? "d8091ab",
          sourcePath: input.sourcePath ?? "demo/OrderPricingService/src/OrderPricing.Api",
          entrypoint: "src/OrderPricing.Api/Program.cs",
          endpoints: ENDPOINTS,
          domainServices: ["PricingService", "DiscountService", "ShippingService"],
          dependencies: [{ name: "Microsoft.AspNetCore.OpenApi", kind: "nuget" }],
          tests: ["OrderPricing.Api.Tests/PricingTests.cs"],
          components: [
            { name: "HTTP surface", riskClass: "GREEN" },
            { name: "Decimal rounding", riskClass: "YELLOW", reason: "Banker's rounding must remain exact" },
          ],
          unsupported: [],
        }),
      };
    }

    if (agentName === "mh-contract") {
      return {
        "migration-contract.json": json({
          migrationId,
          endpoints: ENDPOINTS.map((endpoint) => contractEndpoint(endpoint.method, endpoint.route)),
        }),
        "fixture-plan.json": json({
          migrationId,
          fixtures: 384,
          dotnetTestCases: 37,
          dotnetTestsPassed: 37,
        }),
      };
    }

    if (agentName === "mh-migrator") {
      return {
        "build-report.json": json({
          migrationId,
          cargoCheck: "PASS",
          cargoTest: { passed: 41, total: 41 },
          clippy: "PASS",
          rustTree: RUST_TREE,
        }),
      };
    }

    if (agentName === "mh-parity") {
      const run = (this.parityRuns.get(migrationId) ?? 0) + 1;
      this.parityRuns.set(migrationId, run);
      const mismatch = {
        fixtureId: "fx-0184",
        endpoint: { method: "POST", route: "/quote" },
        input: { customerTier: "gold", subtotal: 249.95, coupon: "SUMMER10", country: "IN" },
        dotnet: { total: 170 },
        rust: { total: 169.99 },
        diff: [{ path: "$.total", expected: 170, actual: 169.99 }],
        hypothesis: "Binary floating-point changed midpoint rounding semantics.",
      };
      const hasMismatch = run === 1;
      return {
        "parity-report.json": json({
          migrationId,
          total: 384,
          passed: hasMismatch ? 383 : 384,
          failed: hasMismatch ? 1 : 0,
          byRoute: [
            { method: "GET", route: "/health", passed: 1, total: 1 },
            { method: "GET", route: "/rules", passed: 1, total: 1 },
            { method: "POST", route: "/quote", passed: hasMismatch ? 127 : 128, total: 128 },
            { method: "POST", route: "/discount", passed: 127, total: 127 },
            { method: "POST", route: "/shipping", passed: 127, total: 127 },
          ],
          mismatches: hasMismatch ? [mismatch] : [],
        }),
      };
    }

    if (agentName === "mh-repair") {
      return {
        "repair-log.json": json({
          migrationId,
          status: "fixed",
          category: "rounding",
          summary: "Replaced f64 money calculations with rust_decimal::Decimal and midpoint-to-even rounding.",
        }),
      };
    }

    if (agentName === "mh-security") {
      return {
        "security-report.json": json({
          migrationId,
          checks: [
            { name: "input-validation-parity", status: "pass" },
            { name: "error-sanitization", status: "pass" },
            { name: "secret-leakage", status: "pass" },
            { name: "cargo-audit", status: "pass" },
            { name: "sensitive-logging", status: "pass" },
          ],
          newHighSeverity: 0,
        }),
      };
    }

    if (agentName === "mh-cutover") {
      return {
        "cutover-report.json": json({
          migrationId,
          mode: "demo",
          status: "simulated",
          pullRequestUrl: `https://github.com/${input.sourceRepo ?? "acme/orderpricing-legacy"}/pull/demo-${migrationId.toLowerCase()}`,
        }),
      };
    }

    return {};
  }

  private parseInput(raw: string): DemoInput {
    try {
      return JSON.parse(raw) as DemoInput;
    } catch {
      const migrationId = raw.match(/MH-\d{4}/)?.[0];
      if (!migrationId) throw new Error("demo stage input did not contain a migration id");
      return { migrationId };
    }
  }

  private activity(agentName: string, migrationId: string): string {
    const messages: Record<string, string> = {
      "mh-architect": "Mapped 5 endpoints and classified decimal rounding as semantic risk.",
      "mh-contract": "Captured exact status, JSON, null, and decimal-scale compatibility rules.",
      "mh-migrator": "Generated the Axum service; cargo check, tests, and clippy passed.",
      "mh-parity":
        (this.parityRuns.get(migrationId) ?? 0) === 1
          ? "Fixture fx-0184 exposed a 170.00 vs 169.99 rounding mismatch."
          : "Re-ran all 384 fixtures: behavioral parity is clean.",
      "mh-repair": "Corrected monetary arithmetic to decimal midpoint-to-even semantics.",
      "mh-security": "All five security-parity checks passed with zero new high-severity findings.",
      "mh-cutover": "Prepared the licensed pull request action; waiting on the operator checkpoint.",
    };
    return messages[agentName] ?? `${agentName} completed.`;
  }

  private async pause(): Promise<void> {
    if (this.stepDelayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
  }

  private async emit(
    onEvent: RunStageParams["onEvent"],
    type: string,
    raw: StageEvent["raw"],
  ): Promise<void> {
    const event: StageEvent = {
      tfSeq: ++this.sequence,
      type,
      threadId: typeof raw.threadId === "string" ? raw.threadId : null,
      raw,
    };
    await onEvent(event);
  }
}
