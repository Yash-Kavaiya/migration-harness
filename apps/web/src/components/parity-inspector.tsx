import { deriveParityMetrics } from "@/lib/model";
import type { ParityEvidence } from "@/lib/types";

export function ParityInspector({
  parity,
  repairRounds,
}: {
  parity: ParityEvidence | null;
  repairRounds: number;
}) {
  const metrics = deriveParityMetrics(parity);
  const mismatch = parity?.mismatches[0];
  const repaired = metrics.total > 0 && metrics.failed === 0;

  return (
    <section className="panel screen stack">
      <div>
        <p className="kicker">Parity inspector</p>
        <h3>{repaired ? "Full pass" : "Decimal rounding trap"}</h3>
      </div>
      <div className="parity">
        <div>
          <div
            className="meter"
            style={{ ["--pct" as string]: String(metrics.percent) }}
            aria-label={`${metrics.percent} percent fixtures passing`}
          />
          <div>
            <b>
              {metrics.passed} / {metrics.total}
            </b>
            <div className="muted">
              {repairRounds > 0 ? `repair round ${repairRounds} of 3` : "golden replay"}
            </div>
          </div>
        </div>
        <div className="stack">
          {mismatch ? (
            <>
              <p>
                {mismatch.endpoint.method} {mismatch.endpoint.route} · {mismatch.fixtureId}
              </p>
              <p className="warn">{mismatch.hypothesis ?? "Response diverged from the .NET golden."}</p>
              <div className="diff">
                <pre className="good">
                  .NET
                  {"\n"}
                  {JSON.stringify(mismatch.dotnet, null, 2)}
                </pre>
                <pre className="bad">
                  Rust
                  {"\n"}
                  {JSON.stringify(mismatch.rust, null, 2)}
                </pre>
              </div>
            </>
          ) : (
            <p className="pass">
              {metrics.total > 0
                ? "Every golden fixture matches. rust_decimal midpoint-to-even restored banker's rounding."
                : "Waiting for mh-parity to replay committed goldens against the generated Axum service."}
            </p>
          )}
          {parity?.byRoute.map((route) => (
            <div key={`${route.method}${route.route}`} className="muted">
              {route.method} {route.route} · {route.passed}/{route.total}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
