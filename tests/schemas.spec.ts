import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  architectureSchema,
  buildReportSchema,
  licenseSchema,
  LICENSE_ID,
  migrationContractSchema,
  migrationManifestSchema,
  MIGRATION_ID,
  parityReportSchema,
  securityReportSchema,
  SHA256_HEX,
} from "@mh/shared/types";
import {
  architecture,
  build,
  contract,
  greenInputs,
  license,
  manifest,
  parityWithMismatches,
  security,
} from "./_builders.js";

const SCHEMA_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));

interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  type?: string;
}

const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"));

describe("schemas/*.schema.json", () => {
  it("ships a JSON Schema for every artifact type", () => {
    expect(schemaFiles.sort()).toEqual([
      "architecture.schema.json",
      "build-report.schema.json",
      "dependency-map.schema.json",
      "fixture.schema.json",
      "license.schema.json",
      "migration-contract.schema.json",
      "migration-manifest.schema.json",
      "parity-report.schema.json",
      "security-report.schema.json",
    ]);
  });

  it.each(schemaFiles)("%s is valid JSON Schema 2020-12 with an $id and title", (file) => {
    const doc = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as JsonSchema;
    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(doc.$id).toMatch(/^https:\/\/migrationharness\.dev\/schemas\/.+\.schema\.json$/);
    expect(doc.title).toBeTruthy();
    expect(doc.type).toBe("object");
  });
});

describe("shared id patterns line up with the JSON Schemas", () => {
  it("migration id", () => {
    expect("MH-0042").toMatch(MIGRATION_ID);
    expect("MH-42").not.toMatch(MIGRATION_ID);
  });
  it("license id", () => {
    expect("LIC-MH-0042-01").toMatch(LICENSE_ID);
    expect("LIC-MH-0042-1").not.toMatch(LICENSE_ID);
  });
  it("sha-256 hex", () => {
    expect("a".repeat(64)).toMatch(SHA256_HEX);
    expect("A".repeat(64)).not.toMatch(SHA256_HEX);
    expect("a".repeat(63)).not.toMatch(SHA256_HEX);
  });
});

describe("zod mirrors accept the fixture builders", () => {
  it("architecture", () => expect(() => architectureSchema.parse(architecture())).not.toThrow());
  it("contract", () => expect(() => migrationContractSchema.parse(contract())).not.toThrow());
  it("build report", () => expect(() => buildReportSchema.parse(build())).not.toThrow());
  it("parity report", () => expect(() => parityReportSchema.parse(parityWithMismatches(2))).not.toThrow());
  it("security report", () => expect(() => securityReportSchema.parse(security())).not.toThrow());
  it("manifest", () => expect(() => migrationManifestSchema.parse(manifest())).not.toThrow());
  it("license", () => {
    const m = manifest();
    expect(() => licenseSchema.parse(license(m))).not.toThrow();
  });
  it("greenInputs is internally consistent", () => {
    const g = greenInputs();
    expect(g.license.approvedManifestSha256).toBe(g.manifest.manifestSha256);
  });
});
