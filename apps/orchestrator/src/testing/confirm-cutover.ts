import type { Orchestrator } from "../orchestrator.js";

/** Drain, then confirm every parked GitHub-write checkpoint. */
export async function confirmCutover(orchestrator: Orchestrator, migrationId: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await orchestrator.drain();
    const pending = orchestrator.view(migrationId)?.pendingInteractions ?? [];
    const approvals = pending.filter((item) => item.kind === "approval");
    if (approvals.length === 0) return;
    for (const interaction of approvals) {
      const result = orchestrator.answerInteraction(migrationId, interaction.eventId, {
        kind: "approval",
        status: "allow",
      });
      if (!result.ok) {
        throw new Error(result.reason ?? "cutover checkpoint was refused");
      }
    }
  }
}
