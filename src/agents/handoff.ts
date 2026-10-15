// PILE-421 — structured handoffs between sub-step agents (OpenAI Agents SDK
// handoffs / Salesforce Flow Orchestration step outputs). A completing
// sub-step lane posts one agent_handoffs row — typed outputs, a next-agent
// suggestion, evidence links — and the next step's dispatch envelope renders
// the parent's prior handoffs instead of prior sessions' transcripts.

export interface HandoffEvidence {
  /** Record kind the ref points at — document, attachment, issue, url, … */
  type?: string;
  /** Document/attachment/issue id or a URL. */
  ref: string;
  label?: string;
}

/** The row view the prompt renderer consumes — satisfied by agent_handoffs
 *  rows straight off the DO. */
export interface HandoffView {
  id: string;
  stepKey: string;
  nextAgent: string | null;
  /** Serialized JSON object — the step's typed outputs. */
  outputs: string;
  /** Serialized JSON array of HandoffEvidence. */
  evidence: string | null;
  createdAt: string;
}

export function parseHandoffOutputs(
  raw: string
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseHandoffEvidence(raw: string | null): HandoffEvidence[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is HandoffEvidence =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as HandoffEvidence).ref === "string"
    );
  } catch {
    return [];
  }
}

/** Render prior handoffs as the prompt section a step-scoped lane consumes.
 *  Callers pass rows already in chronological order; each handoff keeps its
 *  step heading so the lane can attribute outputs to the step that made
 *  them. */
export function renderHandoffs(handoffs: HandoffView[]): string {
  const sections = handoffs.map((handoff) => {
    const outputs = parseHandoffOutputs(handoff.outputs);
    const evidence = parseHandoffEvidence(handoff.evidence);
    return [
      `### ${handoff.stepKey} (${handoff.createdAt})`,
      "",
      "Outputs:",
      "```json",
      JSON.stringify(outputs ?? {}, null, 2),
      "```",
      ...(handoff.nextAgent ? ["", `Next agent: ${handoff.nextAgent}`] : []),
      ...(evidence.length > 0
        ? [
            "",
            "Evidence:",
            ...evidence.map((item) =>
              item.label
                ? `- [${item.label}](${item.ref})${item.type ? ` (${item.type})` : ""}`
                : `- ${item.ref}${item.type ? ` (${item.type})` : ""}`
            ),
          ]
        : []),
    ].join("\n");
  });
  return ["## Prior step handoffs", "", ...sections].join("\n\n");
}
