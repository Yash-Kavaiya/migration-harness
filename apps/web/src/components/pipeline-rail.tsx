import type { PipelineStep } from "@/lib/model";

export function PipelineRail({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="rail" aria-label="Pipeline stages">
      {steps.map((step, index) => (
        <div key={step.id} className={`rail-step ${step.status}`}>
          <span className="idx">{String(index + 1).padStart(2, "0")}</span>
          <span className="name">{step.label}</span>
          <span className="detail">{step.detail ?? step.status}</span>
        </div>
      ))}
    </div>
  );
}
