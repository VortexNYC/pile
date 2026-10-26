// PILE-617/627 — deterministic memory auto-extraction ("dreaming").
// Parses markdown, session results, and comment streams for high-signal
// durable statements and returns normalized memory candidates. Pure and
// synchronous — no I/O — so it runs identically in the DO, the sweep,
// and tests.

export interface ExtractedMemoryCandidate {
  entityType: string;
  entityId: string;
  kind: string;
  fact: string;
}

// Explicit labeled lines: `- **Root cause:** ...`, `Decision: ...`,
// `1. **Lesson** — ...`. Label → normalized kind.
const LABELED_LINE_RE =
  /(?:^|\n)\s*(?:[-*•]|\d+\.)?\s*\*{0,2}(Root cause|Decision|Lesson|Architecture|Fix|Verification|Blocker|Convention|Takeaway|Outcome|Rule)\*{0,2}\s*[:—-]\s*\*{0,2}\s*(.+)/gi;

// Markdown sections whose bullets carry a known kind.
const SECTION_KINDS: Record<string, string> = {
  "root cause": "root_cause",
  decisions: "decision",
  lessons: "lesson",
  architecture: "architecture",
  verification: "verification",
  "key findings": "finding",
  notes: "note",
  summary: "summary",
};

const SECTION_HEADING_RE =
  /(?:^|\n)#{1,6}\s+(Root cause|Decisions|Lessons|Architecture|Verification|Key findings|Notes|Summary)\s*(?:\n|$)/gi;

const BULLET_RE = /^\s*(?:[-*•]|\d+\.)\s+(.+)$/;

const ISSUE_IDENTIFIER_RE = /\b([A-Z]{2,6}-\d+)\b/;

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "_");
}

function cleanFact(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:[-*•]|\d+\.)\s*/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function truncateFact(fact: string, max = 400): string {
  if (fact.length <= max) return fact;
  // Cut at the last word boundary before the cap so facts don't end
  // mid-token.
  const cut = fact.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max - 60 ? cut.slice(0, lastSpace) : cut).trim();
}

export function extractFactsFromMarkdown(input: {
  text: string;
  defaultEntityType: string;
  defaultEntityId: string;
  maxFacts?: number;
}): ExtractedMemoryCandidate[] {
  const maxFacts = input.maxFacts ?? 10;
  const out: ExtractedMemoryCandidate[] = [];
  const seen = new Set<string>();

  const push = (kind: string, rawFact: string): void => {
    const fact = truncateFact(cleanFact(rawFact));
    if (fact.length < 15) return;
    // An explicit leading issue identifier on a workspace-scoped
    // extraction attributes the fact to that issue.
    let entityType = input.defaultEntityType;
    let entityId = input.defaultEntityId;
    if (input.defaultEntityType !== "issue") {
      const m = ISSUE_IDENTIFIER_RE.exec(fact);
      if (m && input.defaultEntityType === "workspace") {
        entityType = "issue";
        entityId = m[1].toUpperCase();
      }
    }
    const key = `${entityType}${entityId}${kind}${fact.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ entityType, entityId, kind, fact });
  };

  // 1. Explicit labeled lines/bullets.
  for (const m of input.text.matchAll(LABELED_LINE_RE)) {
    push(normalizeLabel(m[1]), m[2]);
  }

  // 2. Bullets under known section headings.
  const headings = [...input.text.matchAll(SECTION_HEADING_RE)];
  for (let i = 0; i < headings.length; i++) {
    const kind = SECTION_KINDS[headings[i][1].toLowerCase()];
    if (!kind) continue;
    const start = (headings[i].index ?? 0) + headings[i][0].length;
    const end =
      i + 1 < headings.length
        ? (headings[i + 1].index ?? 0)
        : input.text.length;
    const section = input.text.slice(start, end);
    // A `##` heading terminates the section even if it isn't a known
    // kind (the match list only spans known headings).
    const bounded = section.split(/\n#{1,6}\s/)[0] ?? section;
    for (const line of bounded.split("\n")) {
      const b = BULLET_RE.exec(line);
      if (!b) continue;
      const fact = cleanFact(b[1]);
      if (fact.length < 20) continue;
      push(kind, fact);
    }
  }

  // 3. Fallback — unstructured summary: take the most informative
  // (longest) line as a single outcome fact.
  if (out.length === 0 && input.text.trim().length >= 20) {
    const lines = input.text
      .split("\n")
      .map((l) => cleanFact(l))
      .filter((l) => l.length >= 20 && !/^#{1,6}\s/.test(l.trim()));
    const best =
      lines.toSorted((a, b) => b.length - a.length)[0] ?? input.text.trim();
    const fact = truncateFact(cleanFact(best));
    if (fact.length >= 15) {
      out.push({
        entityType: input.defaultEntityType,
        entityId: input.defaultEntityId,
        kind: "outcome",
        fact,
      });
    }
  }

  return out.slice(0, maxFacts);
}
