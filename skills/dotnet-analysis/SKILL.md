---
name: dotnet-analysis
description: Use when analyzing an ASP.NET Core / .NET service to produce a structured architecture description — enumerating endpoints, DTOs, validators, domain services, dependencies, and per-component migration risk.
---

# Analyzing a .NET service for migration

You are mapping a bounded ASP.NET Core service so it can be re-implemented. Read
only — never modify the source.

## Procedure

1. **Project file.** Read every `.csproj`. Record `<TargetFramework>`, every
   `<PackageReference>` (name + version), `<ProjectReference>`s, and SDK type
   (`Microsoft.NET.Sdk` vs `Microsoft.NET.Sdk.Web`).

2. **Host / entrypoint.** Read `Program.cs` (and `Startup.cs` if present). Note:
   - the minimal-API route registrations or controller conventions
   - middleware order (exception handling, auth, CORS) — order is behavior
   - JSON options (naming policy, null handling, converters, number handling)
   - any hosted services, background workers, or startup work

3. **Endpoints.** For each route: HTTP method, path template, the request DTO type,
   the response DTO type, the status codes it can return, and the handler symbol.

4. **DTOs / models.** For each: every property, its CLR type, nullability
   (`string?` vs `string`), `[JsonPropertyName]` overrides, and default values.
   Flag every `decimal`, `DateTime`/`DateTimeOffset`, `Guid`, and enum.

5. **Domain logic.** Identify the pure computation classes. For each method, note
   inputs, outputs, and any use of: `Math.Round` / `MidpointRounding`, `decimal`
   arithmetic, `CultureInfo`, `string.Compare` / `StringComparison`, LINQ ordering,
   collection equality.

6. **Validation.** Every rule, the order rules are checked, the status code and
   error body shape on failure, and the machine-readable error code if any.

7. **Tests.** List the test project(s) and, per test file, roughly what behavior
   each test pins. This count feeds the "existing tests preserved" gate.

## Risk classification

| Class | Meaning |
|---|---|
| `GREEN` | Pure and trivially portable: routing, plain DTO shapes, enum names. |
| `YELLOW` | Portable but semantics need care: nullability, collection order, culture, string comparison, date handling, integer overflow. |
| `RED` | A wrong port silently changes observable output. **All monetary math, `decimal`, and any `MidpointRounding` is RED.** So is anything with locale-dependent formatting. |

## Unsupported → halt

If the service does any of the following, add it to `unsupported[]` with a reason
and stop — the migration is out of scope, and reporting that is the correct result:

- a database or ORM (EF Core, Dapper), any external HTTP/gRPC call, message queues
- authentication / authorization middleware, session or cookie state
- file-system or blob state, background job scheduling
- SignalR / WebSockets, server-sent events
- reflection-driven behavior, source generators beyond serialization

## Output

Write `architecture.json` conforming to `schemas/architecture.schema.json`. Be
exhaustive on `endpoints[]`, `components[]` (with risk class + reason), and
`dependencies[]`. Leave `unsupported[]` empty only if you are sure.
