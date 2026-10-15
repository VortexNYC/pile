// PILE-423 — guidance packs (Linear's "Guidance" model): scoped markdown
// instruction blocks injected into a lane's dispatch prompt. Packs resolve
// least-specific first (workspace → team → status → step) so the most
// specific guidance lands last, and the session row records the exact pack
// versions it was dispatched with.

export type GuidanceScope = "workspace" | "team" | "status" | "step";

/** The pack shape dispatch consumes — the DO row minus bookkeeping fields. */
export interface ResolvedGuidancePack {
  id: string;
  name: string;
  scope: GuidanceScope;
  scopeKey: string | null;
  body: string;
  /** JSON array of {label?, url} — parsed at render. */
  links: string | null;
  version: number;
}

/** What a session row records: the packs + versions that went into its
 *  prompt, in injection order. Versions resolve against
 *  guidance_pack_versions for the exact text. */
export interface SessionGuidanceRef {
  id: string;
  name: string;
  scope: GuidanceScope;
  scopeKey: string | null;
  version: number;
}

export function guidanceRefs(
  packs: ResolvedGuidancePack[]
): SessionGuidanceRef[] {
  return packs.map((pack) => ({
    id: pack.id,
    name: pack.name,
    scope: pack.scope,
    scopeKey: pack.scopeKey,
    version: pack.version,
  }));
}

export interface GuidanceLink {
  label?: string;
  url: string;
}

export function parseGuidanceLinks(raw: string | null): GuidanceLink[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is GuidanceLink =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as GuidanceLink).url === "string"
    );
  } catch {
    return [];
  }
}

const SCOPE_LABEL: Record<GuidanceScope, string> = {
  workspace: "workspace",
  team: "team",
  status: "stage",
  step: "step",
};

/** Render the resolved packs as the prompt's guidance section. Callers pass
 *  packs already ordered least→most specific; each pack keeps a heading so
 *  the lane can tell which scope a rule came from. */
export function renderGuidancePacks(packs: ResolvedGuidancePack[]): string {
  const sections = packs.map((pack) => {
    const qualifier = pack.scopeKey ? `:${pack.scopeKey}` : "";
    const links = parseGuidanceLinks(pack.links);
    return [
      `### ${pack.name} (${SCOPE_LABEL[pack.scope] ?? pack.scope}${qualifier})`,
      "",
      pack.body,
      ...(links.length > 0
        ? [
            "",
            ...links.map((link) =>
              link.label ? `- [${link.label}](${link.url})` : `- ${link.url}`
            ),
          ]
        : []),
    ].join("\n");
  });
  return ["## Guidance", "", ...sections].join("\n\n");
}
