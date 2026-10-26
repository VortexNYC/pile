// PILE-613 — hybrid semantic + concept-expanded memory recall.
//
// BM25 and LIKE recall only match verbatim terms, so a query like
// "did we sweep smith corridor?" misses a fact written as
// "corridor:smith-st swept yesterday". This module gives the recall path
// three extra recall surfaces: concept/synonym expansion, morphological
// stemming, a token-overlap + char-trigram similarity score, and an
// optional Workers AI + Vectorize embedding path when the bindings exist.

/** Concept groups: querying any member expands to the whole group. */
const CONCEPT_GROUPS: string[][] = [
  [
    "oom",
    "out of memory",
    "crash",
    "crashed",
    "memory limit",
    "isolate reset",
    "heap",
    "memory pressure",
  ],
  [
    "auth",
    "authentication",
    "credentials",
    "token",
    "secret",
    "apikey",
    "api key",
    "veil",
    "oauth",
  ],
  [
    "retry",
    "retries",
    "backoff",
    "rate limit",
    "429",
    "hold",
    "throttle",
    "throttled",
  ],
  [
    "bounce",
    "bounced",
    "undeliverable",
    "suppressed",
    "suppression",
    "opt_out",
    "opt out",
    "unsubscribe",
  ],
  [
    "sweep",
    "swept",
    "corridor",
    "leads",
    "lead",
    "merchant",
    "license",
    "licenses",
  ],
  ["deploy", "deployment", "release", "production", "wrangler", "ci"],
];

/** Minimal morphological normalization — plurals and common verb endings. */
const STEM_ALIASES: Record<string, string> = {
  swept: "sweep",
  retries: "retry",
  crashed: "crash",
  crashes: "crash",
  bounced: "bounce",
  bounces: "bounce",
  tokens: "token",
  licenses: "license",
  deployments: "deploy",
  suppressions: "suppression",
  unsubscribes: "unsubscribe",
  credentials: "credential",
  memories: "memory",
  issues: "issue",
  documents: "document",
  customers: "customer",
};

function normalizeToken(token: string): string {
  let t = token.toLowerCase();
  if (STEM_ALIASES[t]) return STEM_ALIASES[t];
  // Generic morphology: trailing 's', 'es', 'ed', 'ing' — conservative, only
  // strips when the stem is still >= 3 chars so it doesn't eat real words.
  if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
  if (t.endsWith("ed") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("es") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) {
    return t.slice(0, -1);
  }
  return t;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function normalizedTokens(text: string): Set<string> {
  return new Set(tokenize(text).map(normalizeToken));
}

/**
 * Expand a query with concept-group siblings and stemmed variants so BM25
 * gets terms the writer actually used even when the asker didn't.
 */
export function expandSemanticQuery(query: string): string {
  const tokens = tokenize(query);
  const extra = new Set<string>();
  const normalized = tokens.map(normalizeToken);

  // Concept groups: a query token (raw or stemmed) that lands in a group
  // pulls in every sibling term.
  const rawSet = new Set(tokens);
  const haystacks = new Set([...tokens, ...normalized]);
  for (const group of CONCEPT_GROUPS) {
    const groupTokens = group.flatMap((term) => tokenize(term));
    if (groupTokens.some((t) => haystacks.has(t))) {
      for (const term of group) {
        for (const t of tokenize(term)) {
          if (!rawSet.has(t)) extra.add(t);
        }
      }
    }
  }

  // Morphology: always add the stemmed form when it differs from the raw
  // token ("swept" still emits "sweep").
  for (const stem of normalized) {
    if (!rawSet.has(stem)) extra.add(stem);
  }

  const expanded = [...tokens, ...extra].join(" ");
  return expanded || query;
}

function trigramCounts(text: string): Map<string, number> {
  const normalized = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const counts = new Map<string, number>();
  for (let i = 0; i + 3 <= normalized.length; i++) {
    const gram = normalized.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const v of a.values()) aNorm += v * v;
  for (const v of b.values()) bNorm += v * v;
  if (aNorm === 0 || bNorm === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const other = big.get(k);
    if (other !== undefined) dot += v * other;
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

/**
 * Hybrid semantic score in [0, 1]:
 *  - 0.6 * concept-expanded normalized-token containment — how much of the
 *    expanded query concept is covered by the expanded candidate
 *  - 0.4 * character 3-gram cosine similarity
 */
export function computeSemanticSimilarity(
  query: string,
  candidateText: string
): number {
  const queryTokens = normalizedTokens(expandSemanticQuery(query));
  const candidateTokens = normalizedTokens(expandSemanticQuery(candidateText));
  let overlap = 0;
  for (const t of queryTokens) {
    if (candidateTokens.has(t)) overlap++;
  }
  const tokenScore = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;
  const trigramScore = cosine(
    trigramCounts(query),
    trigramCounts(candidateText)
  );
  return Math.min(1, 0.6 * tokenScore + 0.4 * trigramScore);
}

interface VectorizeEnv {
  AI?: { run(model: string, input: { text: string[] }): Promise<unknown> };
  MEMORY_VECTOR_INDEX?: {
    query(
      vec: number[],
      opts: { topK: number; filter?: Record<string, string> }
    ): Promise<{ matches?: Array<{ id: string; score: number }> }>;
  };
}

/**
 * Optional embedding recall — when the worker has `AI` and
 * `MEMORY_VECTOR_INDEX` bindings, embed the query with bge-base and pull
 * the top-K memory IDs for the workspace. Returns [] when the bindings are
 * absent or the call fails; recall degrades to lexical+trigram only.
 */
export async function queryVectorizeMemories(
  env: VectorizeEnv,
  organizationId: string,
  query: string,
  topK = 25
): Promise<string[]> {
  if (!env.AI || !env.MEMORY_VECTOR_INDEX) return [];
  try {
    const embedded = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [query],
    })) as { data?: number[][] };
    const vec = embedded.data?.[0];
    if (!vec || vec.length === 0) return [];
    const result = await env.MEMORY_VECTOR_INDEX.query(vec, {
      topK,
      filter: { organizationId },
    });
    return (result.matches ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}
