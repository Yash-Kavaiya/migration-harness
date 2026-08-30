/**
 * `@mh/shared` — the contract layer shared by the orchestrator, the UI, and the
 * verification tests. Everything here is pure: schemas, hashing, gate logic, and
 * the migration state machine. No I/O, no TrueForge SDK, no Fastify.
 */
export * from "./types.js";
export * from "./gates.js";
export * from "./manifest.js";
export * from "./state.js";
export * from "./parity.js";
export * from "./fixtures.js";
