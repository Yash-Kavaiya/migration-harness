import type { GateResult } from "@/lib/types";

export function GateGrid({ gates }: { gates: GateResult[] }) {
  return (
    <section className="panel screen stack">
      <div>
        <p className="kicker">Quality gates</p>
        <h3>Gate grid</h3>
      </div>
      <div className="gates">
        {gates.map((gate) => (
          <div key={gate.id} className={`gate ${gate.status}`}>
            <span className={`lamp ${gate.status}`} />
            <div>
              <div>
                {gate.n}. {gate.title}
              </div>
              <div className="muted">{gate.detail}</div>
            </div>
            <b>{gate.status.toUpperCase()}</b>
          </div>
        ))}
      </div>
    </section>
  );
}
