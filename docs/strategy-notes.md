Yes. For **Best Use of TrueForge**, I would make **MigrationHarness** the primary project and scope it very carefully.

The winning version is not “AI translates C# to Rust.” It is:

# MigrationHarness

### Autonomous, behavior-verified .NET → Rust modernization agent

**Tagline:** **Migrate. Prove parity. License the cutover.**

The project should demonstrate that an agent can inspect a real repository, derive a behavioral contract, generate Rust, execute both implementations in isolation, repair compilation/test failures, prove behavioral equivalence, preserve a long-running migration session, and stop before changing the canonical implementation.

That directly matches the hackathon's Best Use of TrueForge requirement: real MCP tools, generated code in a sandbox, human approval before consequential actions, delegation to subagents, and sessions that survive reconnects.  TrueForge currently supports MCP, skills, sandbox-as-tool, human checkpoints, subagents, deferred tool loading, Code Mode, large-result offloading, compaction, persistent session state, SDK access, and embeddable UI—all useful here. ([GitHub][1])

---

# 1. The exact job

Give MigrationHarness **one bounded service**:

> **Migrate an ASP.NET Core service to Rust/Axum while preserving its externally observable behavior.**

Do not attempt arbitrary enterprise repositories during the hackathon.

The demo service should be realistic enough to contain:

* REST endpoints
* DTOs and JSON serialization
* validation rules
* business rules
* async functions
* error handling
* unit tests
* integration tests
* OpenAPI contract
* a few dependencies
* 25–50 existing tests

But avoid:

* Entity Framework-heavy applications
* Windows COM
* huge distributed systems
* WPF/WinForms
* reflection-heavy code
* complex authentication infrastructure
* thousands of files

That gives you a difficult but solvable migration.

---

# 2. Demo application

I recommend a service called:

## **OrderPricingService**

Source:

```text
ASP.NET Core / .NET 8
```

Target:

```text
Rust
Axum
Tokio
Serde
Rust Decimal
Tracing
```

Endpoints:

```text
GET  /health
GET  /rules

POST /quote
POST /discount
POST /shipping
```

Example request:

```json
{
  "customerTier": "gold",
  "subtotal": 249.95,
  "coupon": "SUMMER10",
  "country": "IN"
}
```

Response:

```json
{
  "subtotal": 249.95,
  "discount": 34.99,
  "shipping": 0,
  "tax": 38.69,
  "total": 253.65
}
```

Why pricing?

Because tiny semantic differences matter:

* decimal rounding
* percentages
* order of operations
* null/default handling
* validation
* boundary values

That gives the Parity Agent real problems to discover.

---

# 3. Winning architecture

```text
                      ┌────────────────────────┐
                      │      GitHub Repo       │
                      │  ASP.NET Core Service  │
                      └───────────┬────────────┘
                                  │
                              GitHub MCP
                                  │
                                  ▼
╔══════════════════════════════════════════════════════════════╗
║                         TRUEFORGE                            ║
║                                                              ║
║                Migration Orchestrator                        ║
║                         │                                    ║
║         ┌───────────────┼─────────────────┐                  ║
║         │               │                 │                  ║
║         ▼               ▼                 ▼                  ║
║   Architecture       Contract        Dependency              ║
║      Agent            Agent            Agent                 ║
║         │               │                 │                  ║
║         └───────────────┼─────────────────┘                  ║
║                         ▼                                    ║
║                  Migration Contract                          ║
║                         │                                    ║
║                         ▼                                    ║
║                   Migration Agent                            ║
║                         │                                    ║
║                  generates Rust                              ║
║                         │                                    ║
║                         ▼                                    ║
║             ┌─────────────────────────┐                      ║
║             │   TRUEFORGE SANDBOX     │                      ║
║             │                         │                      ║
║             │ dotnet build/test       │                      ║
║             │ cargo build/test        │                      ║
║             │ cargo clippy            │                      ║
║             │ generated test tools    │                      ║
║             └───────────┬─────────────┘                      ║
║                         │                                    ║
║                         ▼                                    ║
║                  Differential Tester                         ║
║                         │                                    ║
║                   .NET vs Rust                               ║
║                         │                                    ║
║                    ┌────┴────┐                               ║
║                    │         │                               ║
║                  FAIL       PASS                             ║
║                    │         │                               ║
║                    ▼         ▼                               ║
║                Repair      QA Agent                          ║
║                 Agent        │                               ║
║                    │         │                               ║
║                    └────┬────┘                               ║
║                         ▼                                    ║
║                 Migration Scorecard                          ║
║                         │                                    ║
║                         ▼                                    ║
║                Immutable Manifest                            ║
║                         │                                    ║
║                  🛑 HUMAN LICENSE                            ║
╚═════════════════════════╪════════════════════════════════════╝
                          │
                       APPROVE
                          │
                          ▼
                      GitHub MCP
                          │
              branch → PR → approved cutover
```

The most important architectural principle:

> **TrueForge owns the agent loop. Your application owns the migration domain.**

Do not put another orchestration framework such as LangGraph or CrewAI above TrueForge. TrueForge already runs model calls, tool execution, sandboxing, approvals, context management and session state. ([GitHub][1])

---

# 4. Agent system

Use **one root + six specialists**.

## Agent 1 — Migration Orchestrator

The root agent owns:

* objective
* migration state
* delegation
* quality thresholds
* tool access
* recovery
* final approval request

It receives something like:

```text
Migrate services/Pricing.Api from .NET 8
to Rust/Axum.

Do not change observable API behavior.

Requirements:
- Existing tests: 100%
- Contract parity: 100%
- Differential fixtures: 100%
- cargo clippy: clean
- security checks: pass
- human approval before canonical GitHub change
```

It should decide which specialist is required next.

---

# 5. Architecture Agent

Purpose:

> Understand what is being migrated before generating anything.

Extract:

```text
Projects
Namespaces
Controllers/routes
DTOs
Domain models
Services
Interfaces
Dependencies
Async boundaries
Configuration
Public contracts
Test structure
```

Output:

```json
migration_graph.json
```

Example:

```json
{
  "entrypoint": "Pricing.Api/Program.cs",
  "routes": 5,
  "domain_services": 3,
  "models": 8,
  "external_dependencies": 4,
  "tests": 37
}
```

Also classify components:

```text
GREEN
Straightforward migration

YELLOW
Semantic attention required

RED
No safe automatic mapping
```

---

# 6. Contract Agent

This is one of the project's killer features.

Before translating code, extract what the application **must continue doing**.

Sources:

* OpenAPI
* controllers
* validators
* tests
* JSON examples
* business rules
* status codes
* error models

Output:

```yaml
endpoint: POST /quote

request:
  customerTier: string
  subtotal: decimal
  coupon: optional string

invariants:
  subtotal: ">= 0"
  total: ">= 0"
  discount: "<= subtotal"

compatibility:
  status_code: exact
  json_fields: exact
  decimal_scale: 2
  null_semantics: exact

quality:
  differential_parity: 100%
```

Now your agent isn't translating syntax.

It is migrating **a contract**.

---

# 7. Dependency Agent

Build a mapping.

Example:

| .NET               | Rust                        |
| ------------------ | --------------------------- |
| ASP.NET Core       | Axum                        |
| `Task<T>`          | `Future` / Tokio            |
| `System.Text.Json` | Serde                       |
| `decimal`          | `rust_decimal::Decimal`     |
| `ILogger<T>`       | tracing                     |
| `HttpClient`       | reqwest                     |
| FluentValidation   | validator/custom validation |
| `DateTimeOffset`   | time/chrono                 |

Each mapping gets a confidence level:

```text
EXACT
SEMANTIC
REQUIRES_REVIEW
UNSUPPORTED
```

Example:

```text
System.Decimal
→ rust_decimal::Decimal

Confidence: HIGH

Reason:
Money calculations require decimal,
not f64.
```

This makes the system appear deliberate rather than prompt-driven.

---

# 8. Migration Agent

Only after the contract exists does this agent generate code.

Target structure:

```text
rust-service/
│
├── Cargo.toml
│
├── src/
│   ├── main.rs
│   ├── app.rs
│   ├── routes/
│   ├── models/
│   ├── domain/
│   ├── services/
│   ├── error.rs
│   └── config.rs
│
└── tests/
    ├── contract_tests.rs
    └── integration_tests.rs
```

Do not translate one source file into one Rust file mechanically.

The agent should be permitted to use idiomatic Rust architecture while preserving externally observable behavior.

---

# 9. Make generated code execution unavoidable

This is a major scoring advantage.

TrueForge's sandbox-as-tool provides isolated code/file execution, and its current implementation can provision a sandbox when needed rather than running generated code on the host. ([GitHub][1])

Inside the sandbox:

```bash
dotnet restore
dotnet build
dotnet test

cargo fmt --check
cargo check
cargo build
cargo test
cargo clippy -- -D warnings
```

The agent should also generate temporary programs when analysis requires them.

Example:

```text
Agent:
I need to identify whether JSON property ordering
is significant in these snapshots.

Creates:
normalize_json.py

Sandbox:
python normalize_json.py fixtures/

Result:
Property ordering is irrelevant in 84 fixtures.
```

This uses the “generated code running in a sandbox” requirement extremely well.

---

# 10. TrueForge Code Mode

Use Code Mode for analysis tasks where a small generated program is more efficient than a long series of tool calls.

Examples:

```text
Generate API fixtures

Parse all .csproj files

Construct dependency graph

Compare OpenAPI schemas

Normalize JSON responses

Compare source/target test outputs

Analyze migration manifest
```

TrueForge currently lists Code Mode among its context-engineering capabilities. ([GitHub][1])

One caution: there is currently an open TrueForge issue concerning destructive-tool handling in Code Mode for some MCP tool annotations. For the hackathon, **do not depend solely on automatic destructive detection** for your safety boundary. Implement an explicit allowlist and a separate human-gated path for external GitHub mutations. ([GitHub][2])

This actually gives you a stronger engineering story.

---

# 11. The core innovation: Behavioral Parity Engine

This is what makes MigrationHarness different from AI coding tools.

Run both services.

```text
                       Fixture
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         .NET version             Rust version
              │                       │
              ▼                       ▼
       Status + headers         Status + headers
       + JSON response          + JSON response
              │                       │
              └───────────┬───────────┘
                          ▼
                       Normalizer
                          │
                          ▼
                       Comparator
                          │
                 ┌────────┴────────┐
                 │                 │
               MATCH            MISMATCH
                 │                 │
                 ▼                 ▼
               PASS          Repair Agent
```

---

# 12. Fixture generation

Generate a test matrix.

For pricing:

```text
Customer tiers:
standard
silver
gold

Subtotal:
0
0.01
9.99
100
249.95
999999.99

Coupons:
null
valid
expired
invalid

Country:
IN
US
GB

Boundary cases:
negative values
very large values
nulls
unicode
long strings
invalid enums
```

You can create 200–500 deterministic fixtures quickly.

Target screen:

```text
Differential Parity

384 / 384 fixtures PASS
```

Very strong.

---

# 13. Deliberately include one semantic trap

Build one known migration issue into your demo repo.

Best choice:

## Decimal rounding

.NET:

```text
decimal
MidpointRounding.ToEven
```

Initial Rust generation accidentally uses:

```text
f64
```

Result:

```text
Fixture #184

.NET:
170.00

Rust:
169.99

MISMATCH
```

Then:

```text
Parity Agent
↓
identifies monetary calculation mismatch
↓
Repair Agent
↓
switches calculation to Decimal
↓
reruns tests
↓
384 / 384 PASS
```

Do not script the exact repair in the agent prompt.

Let the real agent diagnose it.

That is the **hero technical moment**.

---

# 14. Repair loop

Use a generic loop:

```text
Generate
   ↓
cargo check
   ↓
FAIL ─────────────→ Repair
   ▲                  │
   └──────────────────┘

PASS
 ↓
cargo test
 ↓
FAIL → Repair

PASS
 ↓
Differential parity
 ↓
FAIL → Repair

PASS
 ↓
cargo clippy
 ↓
FAIL → Repair

PASS
 ↓
Security QA
 ↓
PASS
 ↓
Migration Ready
```

Limit retries:

```text
Maximum repair attempts:
3 per failure class
```

If still failing:

```text
ESCALATE TO HUMAN
```

This shows responsible autonomy.

---

# 15. Migration Skills

Create git-backed TrueForge skills.

TrueForge can load `SKILL.md` instruction packs on demand inside the sandbox. ([GitHub][1])

Recommended skills:

```text
skills/
├── dotnet-analysis/
│   └── SKILL.md
│
├── dotnet-to-rust/
│   └── SKILL.md
│
├── rust-axum/
│   └── SKILL.md
│
├── behavioral-parity/
│   └── SKILL.md
│
└── secure-migration/
    └── SKILL.md
```

### `dotnet-to-rust`

Contains migration guidance for:

* async
* nullable values
* decimal semantics
* exception → Result handling
* LINQ equivalents
* collection semantics

### `behavioral-parity`

Defines:

* exact vs normalized comparison
* allowed tolerances
* headers
* JSON normalization
* timestamp normalization

### `secure-migration`

Defines:

* path restrictions
* secret scanning
* dependency review
* external-write policy

---

# 16. Deferred tool loading

Don't expose every tool to every agent.

Example:

### Architecture Agent

Allowed:

```text
GitHub READ
filesystem READ
sandbox analysis
```

Denied:

```text
GitHub WRITE
merge
deployment
```

### Migration Agent

Allowed:

```text
sandbox
workspace write
compiler
```

No GitHub mutation.

### Publisher/Cutover Agent

Only created near the end.

Allowed:

```text
GitHub WRITE
```

But its write tools require explicit approval.

This is good **least-capability design**.

TrueForge supports deferred tool loading, so you can load relevant tools only when needed. ([GitHub][1])

---

# 17. Risk classification

Every action should receive one of three classes.

### GREEN — automatic

```text
Read repository
Read files
Generate migration plan
Create sandbox files
Compile code
Run tests
Run benchmark
```

### AMBER — automatic + audited

```text
Overwrite generated sandbox code
Delete generated sandbox file
Regenerate test fixtures
Change target implementation in sandbox
```

### RED — explicit human license

```text
Push GitHub branch
Create migration PR
Merge PR
Modify canonical branch
Trigger deployment
Delete legacy service
```

Never ask for approval for ordinary local work.

Otherwise the agent feels crippled.

---

# 18. The Migration Manifest

Before human approval, freeze exactly what is about to change.

Example:

```json
{
  "migration_id": "MH-0042",
  "source_commit": "d8091a...",
  "source": "Pricing.Api",
  "target": "pricing-rust",
  "target_branch": "main",

  "files": {
    "created": 21,
    "modified": 4,
    "deleted": 1
  },

  "validation": {
    "dotnet_tests": "37/37",
    "rust_tests": "41/41",
    "differential_tests": "384/384",
    "clippy": "PASS",
    "security": "PASS"
  },

  "manifest_sha256": "..."
}
```

The human authorizes **this exact artifact**.

---

# 19. Approval invalidation

This is a major differentiator.

After approval:

```text
Approved SHA:
63AF91...
```

Before GitHub mutation:

```text
Current SHA:
63AF91...

MATCH ✓
```

If code changes:

```text
Current SHA:
90B4C2...

MISMATCH

Migration changed after authorization.

Previous license invalidated.

HUMAN RE-APPROVAL REQUIRED.
```

This elevates your safety design substantially.

---

# 20. Human approval UI

Make this one of your most polished screens.

```text
┌────────────────────────────────────────────────┐
│             MIGRATION LICENSE                  │
│                                                │
│ OrderPricingService                            │
│                                                │
│ .NET 8                 → Rust / Axum           │
│                                                │
│ ────────────────────────────────────────────── │
│                                                │
│ Existing tests              37 / 37      PASS │
│ Rust tests                  41 / 41      PASS │
│ Behavioral parity          384 / 384     PASS │
│ API compatibility           100%         PASS │
│ Clippy                       0 warnings   PASS │
│ Security                     PASS               │
│                                                │
│ Files                                        │
│ +21  ~4  -1                                  │
│                                                │
│ Target                                        │
│ main                                          │
│                                                │
│ Action                                        │
│ Replace canonical .NET implementation         │
│                                                │
│ Manifest                                      │
│ SHA256: 63AF91...                             │
│                                                │
│ [ DENY ]         [ LICENSE MIGRATION ]        │
└────────────────────────────────────────────────┘
```

Avoid a generic:

> Approve / Cancel

**LICENSE MIGRATION** makes the theme memorable.

---

# 21. Migration quality gates

Do not allow approval unless all mandatory checks pass.

Example:

```text
GATE 1
Source discovery
PASS

GATE 2
Migration contract
PASS

GATE 3
Rust compilation
PASS

GATE 4
Unit tests
PASS

GATE 5
Behavioral parity
100%

GATE 6
API compatibility
100%

GATE 7
cargo clippy
PASS

GATE 8
Security validation
PASS

GATE 9
Human license
WAITING
```

One glance explains the entire product.

---

# 22. Security parity

Migration can accidentally weaken security.

Have QA compare:

```text
Input validation
Error handling
Authentication expectations
Authorization assumptions
CORS policy
Secret handling
SQL/query handling
Sensitive logging
Header behavior
Rate-limit semantics if applicable
```

Output:

```text
SECURITY PARITY

Input validation        PASS
Error sanitization      PASS
Secret scan             PASS
Dependency audit        PASS
Sensitive logging       PASS

New high-severity risks:
0
```

---

# 23. Dependency/security tooling

In the sandbox you can run:

```bash
cargo audit
cargo clippy -- -D warnings
cargo test
```

and normal .NET checks as available.

Do not claim that these prove security.

Describe them accurately:

> automated security and dependency checks.

Human review remains part of the cutover.

---

# 24. Performance report

Use only as a secondary feature.

Run exactly the same local workload on both implementations.

Report:

```text
LOCAL BENCHMARK

                        .NET       Rust

Startup                 413 ms      58 ms
Idle memory              82 MB      18 MB
p50                      3.4 ms     2.0 ms
p95                      8.1 ms     4.6 ms
```

Add:

> Results from the demo environment; not a general .NET-vs-Rust claim.

This makes you look technically credible.

Do **not** make performance the primary success criterion.

Behavioral parity is primary.

---

# 25. Long-running session

Migration is naturally multi-stage.

Persist:

```json
{
  "migration_id": "MH-0042",
  "stage": "differential_testing",
  "source_commit": "d8091a",
  "fixtures_total": 384,
  "fixtures_completed": 221,
  "current_failure": null
}
```

UI:

```text
MH-0042

Discovery       ✓
Contract        ✓
Dependencies    ✓
Generation      ✓
Build           ✓
Unit Tests      ✓
Parity          ● 221/384
Security        ○
Approval        ○
```

Refresh browser.

Then:

```text
Reconnected to MH-0042

Parity testing resumed
221 / 384
```

TrueForge persists session state so agent work can continue across reconnects/restarts. ([Truefoundry][3])

That directly addresses the prize text.

---

# 26. Large-result offloading

Do not push the entire repository and every compiler log into model context.

Use workspace files:

```text
/workspace/MH-0042/

source-analysis/
migration/
contracts/
fixtures/
test-results/
parity/
security/
reports/
publication/
```

Examples:

```text
architecture.json
migration_contract.yaml
dependency_map.json
parity_failures.json
quality_report.json
migration_manifest.json
```

TrueForge explicitly supports large-result offloading and compaction for long-running agent contexts. ([GitHub][1])

Mention this in your README.

It demonstrates you understand harness engineering.

---

# 27. Migration dashboard

For Best UI, avoid a chatbot-first product.

Use an operational control center.

```text
┌──────────────────────────────────────────────────────────────┐
│ MIGRATIONHARNESS        MH-0042            RUNNING ●        │
├──────────────┬─────────────────────────┬─────────────────────┤
│ PIPELINE     │ AGENT ACTIVITY          │ PARITY              │
│              │                         │                     │
│ Discovery ✓  │ Parity Agent            │ 347 / 384           │
│ Contract  ✓  │ ● Running               │ █████████████░ 90%   │
│ Generate  ✓  │                         │                     │
│ Build     ✓  │ Sandbox                 │ Current mismatch    │
│ Tests     ✓  │ > compare_fixture.py    │                     │
│ Parity    ●  │                         │ Fixture #348        │
│ Security  ○  │ .NET  170.00            │                     │
│ License   ○  │ Rust  169.99            │ Rounding mismatch   │
│              │                         │                     │
│              │ RepairAgent started     │ [Inspect]           │
├──────────────┴─────────────────────────┴─────────────────────┤
│ TRUEFORGE │ MCP ✓ │ SANDBOX ✓ │ SUBAGENTS 2 │ SESSION ✓    │
└──────────────────────────────────────────────────────────────┘
```

Three questions should always be answerable:

1. What is the agent doing?
2. What has it proved?
3. What authority does it currently have?

---

# 28. Five screens only

### Screen 1 — Migration Contract

Select:

```text
Repository
Source project
Target framework
Required quality thresholds
```

### Screen 2 — Live Migration

Show:

* stages
* subagent events
* generated code
* sandbox
* current failure

### Screen 3 — Parity Inspector

Show:

```text
input
.NET response
Rust response
diff
agent diagnosis
```

### Screen 4 — License Migration

Show immutable manifest.

### Screen 5 — Complete

Show:

```text
GitHub PR/commit
final score
audit trail
```

---

# 29. Agent timeline

Visible timeline:

```text
14:21:02  MCP
Repository loaded

14:21:04  SUBAGENT
Architecture Agent started

14:21:18  CONTRACT
5 endpoints captured

14:21:32  SUBAGENT
Dependency Agent completed

14:22:01  AGENT
Generated Rust project

14:22:03  SANDBOX
cargo check

14:22:04  FAILURE
Type mismatch in pricing.rs

14:22:07  SUBAGENT
Repair Agent started

14:22:14  SANDBOX
cargo check PASS

14:22:38  PARITY
Fixture 184 mismatch

14:22:45  REPAIR
Decimal semantics corrected

14:23:12  PARITY
384/384 PASS

14:23:45  CHECKPOINT
Migration license required
```

This visually proves that the harness is doing the work.

---

# 30. Repository structure

I recommend:

```text
migration-harness/
│
├── README.md
├── LICENSE
├── .env.example
│
├── apps/
│   ├── web/
│   └── api/
│
├── agents/
│   ├── orchestrator/
│   ├── architecture/
│   ├── contract/
│   ├── dependency/
│   ├── migration/
│   ├── parity/
│   └── repair/
│
├── skills/
│   ├── dotnet-analysis/
│   ├── dotnet-to-rust/
│   ├── rust-axum/
│   ├── behavioral-parity/
│   └── secure-migration/
│
├── schemas/
│   ├── migration-contract.schema.json
│   ├── dependency-map.schema.json
│   ├── parity-result.schema.json
│   └── migration-manifest.schema.json
│
├── sandbox/
│   ├── run_dotnet.sh
│   ├── run_rust.sh
│   ├── differential_test.py
│   └── benchmark.py
│
├── demo/
│   └── OrderPricingService/
│
├── tests/
│   ├── approvals/
│   ├── parity/
│   ├── security/
│   └── manifest/
│
└── docs/
    ├── architecture.md
    ├── safety.md
    ├── demo-script.md
    └── qodo.md
```

---

# 31. Tech stack

Keep it predictable.

## Agent layer

**TrueForge**

Central system.

## UI

```text
Next.js
TypeScript
Tailwind CSS
```

## Migration target

```text
Rust
Axum
Tokio
Serde
rust_decimal
tracing
```

## Source

```text
.NET 8
ASP.NET Core
```

## Utilities

```text
Python
Bash
Docker if required
```

## Repository

```text
GitHub MCP
```

Don't spend two days introducing Kubernetes.

---

# 32. GitHub MCP policy

Separate reads from writes.

### Safe/read tools

Preloaded or accessible early:

```text
get repository
read files
read branch
read commits
```

### Write tools

Deferred until final stage:

```text
create branch
push change
create PR
merge PR
```

All RED actions go through your explicit approval policy.

Given the current TrueForge Code Mode destructive-tool issue, this explicit separation is particularly important. ([GitHub][2])

---

# 33. Qodo strategy

The hackathon requires substantive merges to go through Qodo-reviewed PRs and asks for evidence in the README. 

Do this from the first day.

Recommended PRs:

| PR  | Content                              |
| --- | ------------------------------------ |
| #1  | Bootstrap TrueForge + domain schemas |
| #2  | GitHub MCP read integration          |
| #3  | Sandbox .NET/Rust execution          |
| #4  | Architecture + Contract agents       |
| #5  | Migration + Repair agents            |
| #6  | Differential parity engine           |
| #7  | Approval/manifest security           |
| #8  | GitHub write/cutover                 |
| #9  | UI                                   |
| #10 | Hardening/tests/docs                 |

For each:

```text
branch
→ PR
→ Qodo review
→ fix valid findings
→ follow-up review
→ human merge
```

---

# 34. Qodo finding you would love to receive

Suppose Qodo catches:

> Approved migration manifest can be modified before execution.

Fix it by verifying the hash immediately before the write.

README:

```text
Qodo identified a time-of-check/time-of-use risk
between human approval and execution.

We changed the publication path so the manifest is
hashed at approval and verified again immediately
before the GitHub mutation. Any difference invalidates
the authorization.
```

That is fantastic Best Code Quality evidence.

Do not intentionally insert vulnerabilities, though. Let normal development expose legitimate review findings.

---

# 35. Critical automated tests

P0 tests:

```text
migration_cannot_publish_without_approval
PASS

modified_manifest_invalidates_approval
PASS

unapproved_repository_rejected
PASS

workspace_path_traversal_rejected
PASS

target_code_does_not_execute_on_host
PASS

failed_parity_blocks_cutover
PASS

failed_security_gate_blocks_cutover
PASS

valid_manifest_after_approval_can_proceed
PASS
```

These are more valuable than dozens of superficial tests.

---

# 36. Failure injection

Before recording, test:

```text
Rust compiler error
Test failure
Parity mismatch
GitHub MCP timeout
Sandbox timeout
Session disconnect
Approval rejection
Manifest mutation
Unsupported dependency
```

Each needs a reasonable response.

Example:

```text
UNSUPPORTED MIGRATION

Component:
LegacyComInterop

Reason:
No verified native Rust equivalent.

Automatic cutover blocked.

Options:
Keep component in .NET
Use service boundary
Request architecture decision
```

That increases trust.

---

# 37. Three-minute winning demo

## 0:00–0:15 — Problem

Show legacy `.NET` repository.

Say:

> “Migrating production code isn't translation. The new implementation has to preserve behavior, survive real tests, and shouldn't replace the old system just because an AI says it looks correct.”

---

## 0:15–0:30 — Contract

Show:

```text
Source
Pricing.Api / .NET 8

Target
Rust / Axum

Quality gates
Tests              100%
Behavior parity    100%
API contract       100%
Clippy             PASS

Cutover
Human license required
```

Click:

**Start Migration**

---

## 0:30–0:50 — TrueForge

Show:

```text
TrueForge Session MH-0042

GitHub MCP       CONNECTED
Sandbox          ACTIVE
Skills           4 available
Subagents        ENABLED
```

Architecture and Contract agents start.

---

## 0:50–1:12 — generated code

Show Rust being generated.

Then sandbox:

```text
$ cargo check

error[E0308]
mismatched types

expected Decimal
found f64
```

Repair Agent activates.

```text
$ cargo check

PASS
```

Say:

> “The code the model generates is compiled and tested inside TrueForge's sandbox, not trusted or executed directly on the host.”

---

## 1:12–1:42 — killer parity moment

Show:

```text
Differential test
Fixture #184

.NET
170.00

Rust
169.99

MISMATCH
```

Agent diagnosis:

```text
Likely semantic difference:
monetary rounding
```

Repair.

Rerun:

```text
384 / 384

BEHAVIORAL PARITY ✓
```

This is the most important 30 seconds.

---

# 38. 1:42–1:55 — quality

Show:

```text
Existing tests        37/37
Rust tests            41/41
Parity                384/384
API contract          100%
Clippy                PASS
Security checks       PASS
```

---

# 39. 1:55–2:07 — persistence

Refresh.

```text
Reconnecting...

Session MH-0042 restored.

Stage:
Migration Ready
```

Say:

> “The migration belongs to the TrueForge session, not the browser tab.”

Then continue.

---

# 40. 2:07–2:37 — license

Show hero screen.

```text
MIGRATION LICENSE

Pricing.Api
.NET → Rust

37/37 source tests
41/41 Rust tests
384/384 behavioral fixtures
100% API parity

Target:
main

Files:
+21 ~4 -1

Manifest:
63AF91...

This changes the canonical implementation.

[ DENY ]

[ LICENSE MIGRATION ]
```

Say:

> “The migration is technically complete. But TrueForge has stopped because the next action changes the real repository.”

Pause.

Click:

**LICENSE MIGRATION**

---

# 41. 2:37–2:52 — real MCP action

Show:

```text
GitHub MCP

Create migration branch       ✓
Push verified migration       ✓
Create PR                     ✓
```

If you can safely demonstrate a merge in your own demo repo:

```text
Merge approved migration      ✓
```

Otherwise stopping at a real PR is fine, but merging gives the stronger cutover narrative.

---

# 42. 2:52–3:00 — close

Show:

```text
MIGRATION COMPLETE

Behavior preserved        ✓
Rust validation           ✓
Human authorization       ✓
GitHub updated            ✓

TrueForge events          186
```

Close with:

> **“MigrationHarness doesn't ask you to trust generated code. It proves behavioral parity, then asks for a license to change the system.”**

That's the line I would use.

---

# 43. README opening

Your README's first screen should say:

> **MigrationHarness autonomously migrates bounded .NET services to Rust, but generated code does not earn authority simply by compiling. TrueForge connects the real repository through MCP, executes generated code inside an isolated sandbox, delegates architecture/migration/parity work to specialist agents, preserves long-running migration state, and stops before canonical cutover until a human licenses the exact verified migration manifest.**

Then immediately show an architecture GIF/image.

---

# 44. README structure

```text
# MigrationHarness

## Problem

## Demo

## Why Migration Is More Than Translation

## Why This Needs TrueForge

## Architecture

## Agent System

## Migration Contract

## Differential Parity

## Sandbox Execution

## Human License

## Security Model

## Session Persistence

## Qodo Review Evidence

## Running Locally

## Demo Repository

## Tests

## Limitations
```

Keep **Why This Needs TrueForge** near the top.

---

# 45. Why TrueForge table

| Problem                | MigrationHarness + TrueForge    |
| ---------------------- | ------------------------------- |
| Real source repository | GitHub MCP                      |
| Agent-generated Rust   | sandboxed execution             |
| Compiler/test failures | iterative agent tool loop       |
| Migration complexity   | specialist subagents            |
| Long job               | persistent session + compaction |
| Huge outputs           | result/file offloading          |
| Tool explosion         | deferred loading                |
| Dangerous cutover      | explicit human checkpoint       |
| Domain expertise       | on-demand skills                |

This almost maps one-to-one to the prize criteria.

---

# 46. MVP

Do not call the project viable until this exact sequence works:

```text
GitHub repo
↓
TrueForge reads .NET
↓
Contract created
↓
Rust generated
↓
cargo check in sandbox
↓
Rust test
↓
.NET vs Rust parity tests
↓
quality report
↓
human checkpoint
↓
GitHub mutation
```

Everything else is optional until that works.

---

# 47. P0 — must ship

Protect these:

* TrueForge root loop.
* GitHub MCP read.
* GitHub MCP write.
* isolated sandbox.
* generated Rust execution.
* at least two real specialist subagents.
* behavioral parity engine.
* one autonomous failure/repair.
* persistent reconnect.
* migration quality gate.
* immutable migration manifest.
* human license.
* real GitHub external action.
* Qodo review trail.
* clean 3-minute demo.

---

# 48. P1 — winning differentiators

After P0:

* Architecture Agent.
* Dependency Agent.
* migration skills.
* Code Mode.
* deferred write tools.
* parity inspector UI.
* security parity.
* manifest hash invalidation.
* agent timeline.
* performance comparison.
* unsupported-migration escalation.

---

# 49. P2 — avoid unless everything works

Only afterward:

* database migration
* Docker generation
* CI migration
* Kubernetes manifests
* multiple Rust frameworks
* Java migration
* Go migration
* full repository migration
* cloud deployment

They will eat your hackathon.

---

# 50. Build plan for remaining days

## Day 1 — TrueForge foundation

Finish:

```text
Repository
TrueForge
Model
GitHub MCP READ
Sandbox
Qodo
```

Acceptance criterion:

> TrueForge reads a C# source file and executes `cargo --version` and `dotnet --version` in the sandbox.

---

# 51. Day 2 — Vertical migration

Only one endpoint.

```text
POST /quote
```

Achieve:

```text
C#
↓
contract
↓
Rust
↓
cargo build
↓
equivalent endpoint
```

Do not build the UI.

---

# 52. Day 3 — Parity + agents

Add:

```text
Architecture Agent
Contract Agent
Migration Agent
Repair Agent

Differential fixture runner
```

End-of-day acceptance:

```text
one deliberate mismatch
↓
agent discovers it
↓
agent repairs it
↓
all fixtures pass
```

If you get this, you have the core of a winning project.

---

# 53. Day 4 — safety + external action

Build:

```text
quality gates
migration manifest
hash
approval checkpoint
GitHub write
```

Test:

```text
without approval → BLOCK

modified after approval → BLOCK

valid approval → ALLOW
```

Now your complete loop exists.

---

# 54. Day 5 — persistence + UI

Build only the five screens.

Add:

```text
session reconnect
agent timeline
parity inspector
license screen
completion view
```

Make the license UI exceptional.

---

# 55. Final day

No architecture changes.

Do:

```text
Fresh-clone test

Qodo reviews complete

Security review

README

Screenshots

Demo recording

Blog

Social post

Submission
```

Record at least 2–3 full takes.

---

# 56. Stop conditions

At the end of each stage ask:

### Foundation

Can TrueForge reach GitHub and sandbox?

### Vertical slice

Can it migrate one real route?

### Intelligence

Can it discover and repair a semantic mismatch?

### Safety

Can it prove that unauthorized cutover is impossible?

### Presentation

Can a judge understand the whole thing without reading code?

If the answer is no, don't add features.

---

# 57. Judging target

If well executed, I would target:

| Criterion            |      Target |
| -------------------- | ----------: |
| Potential impact     |  **9.5/10** |
| Creativity           |    **9/10** |
| Technical excellence |  **9.5/10** |
| TrueForge use        |   **10/10** |
| Control & safety     |   **10/10** |
| Presentation         |  **9.5/10** |
| **Total target**     | **57.5/60** |

Nobody can predict an actual judge score, but this architecture has a high ceiling because the harness is genuinely essential.

---

# 58. Why this is stronger than a generic coding agent

GitHub Copilot/Codex-style tools can already generate Rust.

That's not your innovation.

Your innovation is the lifecycle:

```text
UNDERSTAND
      ↓
CONTRACT
      ↓
MIGRATE
      ↓
EXECUTE
      ↓
COMPARE
      ↓
REPAIR
      ↓
PROVE
      ↓
LICENSE
      ↓
CUT OVER
```

The sentence judges should remember is:

> **“Compilation proves Rust syntax. MigrationHarness proves behavior.”**

And the TrueForge sentence:

> **“The model writes replacement code; TrueForge provides the controlled runtime that determines whether that code earns a license to act.”**

If you can reliably demonstrate **real GitHub MCP → subagent contract extraction → agent-generated Rust → TrueForge sandbox compile → intentional behavioral mismatch → autonomous repair → 100% differential parity → reconnect → immutable human approval → real GitHub write**, I would prioritize **MigrationHarness** over LectureForge for the DGX Spark track. ([GitHub][1])

I can also help you turn this into a **file-by-file implementation blueprint with exact TrueForge agent prompts, MCP tools, schemas, REST endpoints, Next.js screens, and the first 10 GitHub issues/PRs to create**.

[1]: https://github.com/truefoundry/trueforge?utm_source=chatgpt.com "GitHub - truefoundry/trueforge: The open-source agent harness - the runtime layer that turns an LLM into a working agent. · GitHub"
[2]: https://github.com/truefoundry/trueforge/issues/318?utm_source=chatgpt.com "Code Mode destructive-tool gate fails open on unannotated tools (and errors on annotated ones with mcp >=2.0) · Issue #318 · truefoundry/trueforge · GitHub"
[3]: https://www.truefoundry.com/blog/engineering/trueforge-open-source-agent-harness/?utm_source=chatgpt.com "TrueForge: Open-Source Alternative to Claude Managed Agents"
