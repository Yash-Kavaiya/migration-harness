/**
 * The turn input handed to `mh-repair`: the rendered, blindness-preserving
 * evidence bundle built from the last `parity` run — never a generic prompt and
 * never `mh-parity`'s prose. If parity has not run yet (it always has by the time
 * repair is scheduled) the caller falls back to the default stage input.
 */
import type { ParityReport } from "@mh/shared";
import type { Store } from "../store.js";
import {
  buildEvidenceBundle,
  renderEvidenceBundle,
  type CargoOutput,
  type ParityMismatchInput,
} from "../parity/evidence.js";

const EMPTY_CARGO: CargoOutput = { exitCode: 0, stdout: "", stderr: "" };

export function buildRepairInput(store: Store, migrationId: string, round: number): string | null {
  const parity = store.getArtifact<ParityReport>(migrationId, "parity");
  if (!parity || parity.mismatches.length === 0) return null;

  const cargo = store.getArtifact<CargoOutput>(migrationId, "parity-cargo") ?? EMPTY_CARGO;

  const mismatches: ParityMismatchInput[] = parity.mismatches.map((m) => ({
    fixtureId: m.fixtureId,
    endpoint: m.endpoint,
    input: m.input,
    dotnet: m.dotnet,
    rust: m.rust,
  }));

  const bundle = buildEvidenceBundle({
    migrationId,
    totalFixtures: parity.total,
    failed: parity.failed,
    mismatches,
    cargo,
    round,
  });

  return renderEvidenceBundle(bundle);
}
