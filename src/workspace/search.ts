import type { Issue } from "../types/workspace.js";

// PILE-612 — compact in-DO BM25 index. `@orama/orama` built a per-character
// Radix tree plus per-token object maps and retained full description/body
// copies, which consumed ~172 MB retained / ~790 MB peak on mature
// workspaces and reset the 128 MB Durable Object isolate. This index keeps
// postings packed into 30-bit V8 SMIs (single-doc tokens stored as a bare
// `number`, no array allocation), stores no body/description text, and
// tombstones deletes so removals are O(1).

/** Kept exported for compatibility — describes the logical document shape. */
export const searchSchema = {
  id: "string",
  kind: "enum",
  issueId: "enum",
  teamId: "enum",
  identifier: "string",
  title: "string",
  description: "string",
  body: "string",
  status: "enum",
  documentId: "enum",
  memoryId: "enum",
} as const;

export interface SearchDocument {
  id: string;
  kind: string;
  issueId: string;
  teamId: string;
  identifier: string;
  title: string;
  description: string;
  body: string;
  status: string;
  documentId: string;
  memoryId?: string;
}

const MAX_SEARCH_TEXT_CHARS = 8_192;
const MAX_SEARCH_TOKEN_CHARS = 256;
const MAX_STORED_TITLE_CHARS = 512;
const MAX_UNIQUE_TOKENS_PER_DOC = 192;
const MAX_QUERY_TERMS = 32;

const TOKEN_RE = /[a-z0-9]{2,64}/g;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Per-entry metadata. Deliberately excludes `description`/`body` text —
 *  those are tokenized on insert and immediately garbage-collected, which
 *  is what keeps the index inside the DO isolate's 128 MB ceiling. */
interface IndexedEntry {
  id: string;
  kind: string;
  issueId: string;
  teamId: string;
  identifierLower: string;
  /** Sanitized title capped at 512 chars — needed verbatim by
   *  `titleOverlapScore` when re-ranking duplicate candidates. */
  title: string;
  status: string;
  documentId: string;
  memoryId: string;
  titleLen: number;
  descLen: number;
  bodyLen: number;
  deleted: boolean;
}

export interface WorkspaceSearchIndex {
  /** Slot-addressed entries; slots are never reused (deletes tombstone). */
  entries: IndexedEntry[];
  idToSlot: Map<string, number>;
  /** issueId → every indexed entry attached to it (issue, comments,
   *  issue-scoped memories) for O(1) removeIssueDocuments. */
  issueToSlots: Map<string, Set<number>>;
  /** token → packed posting(s). Each posting packs
   *  (slot << 10) | (bodyTf << 6) | (descTf << 3) | titleTf into a 30-bit
   *  SMI; a token seen in exactly one doc stores the bare `number`. */
  postings: Map<string, number | number[]>;
  activeCount: number;
  totalTitleLen: number;
  totalDescLen: number;
  totalBodyLen: number;
}

export function createWorkspaceSearchIndex(): WorkspaceSearchIndex {
  return {
    entries: [],
    idToSlot: new Map(),
    issueToSlots: new Map(),
    postings: new Map(),
    activeCount: 0,
    totalTitleLen: 0,
    totalDescLen: 0,
    totalBodyLen: 0,
  };
}

export interface SearchIndexMetrics {
  activeDocs: number;
  totalSlots: number;
  vocabSize: number;
}

export function getSearchIndexMetrics(
  index: WorkspaceSearchIndex
): SearchIndexMetrics {
  return {
    activeDocs: index.activeCount,
    totalSlots: index.entries.length,
    vocabSize: index.postings.size,
  };
}

/** Bound text length and single-token length before tokenization: a
 *  multi-hundred-KB log dump or a single contiguous 200 KB token (VTX-649)
 *  must not dominate the index build. */
export function sanitizeSearchText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\S{256,}/g, (token) => token.slice(0, MAX_SEARCH_TOKEN_CHARS))
    .slice(0, MAX_SEARCH_TEXT_CHARS);
}

/** Lowercase alphanumeric tokens (2–64 chars) → term frequencies. Unique
 *  tokens are capped so a noisy document cannot explode vocabulary size. */
function tokenizeField(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text) return counts;
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    const token = match[0];
    const prev = counts.get(token);
    if (prev === undefined) {
      if (counts.size >= MAX_UNIQUE_TOKENS_PER_DOC) continue;
      counts.set(token, 1);
    } else {
      counts.set(token, prev + 1);
    }
  }
  return counts;
}

function tokenCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function addPosting(
  index: WorkspaceSearchIndex,
  token: string,
  packed: number
): void {
  const existing = index.postings.get(token);
  if (existing === undefined) {
    index.postings.set(token, packed);
  } else if (typeof existing === "number") {
    index.postings.set(token, [existing, packed]);
  } else {
    existing.push(packed);
  }
}

function markDeleted(index: WorkspaceSearchIndex, slot: number): void {
  const entry = index.entries[slot];
  if (entry.deleted) return;
  entry.deleted = true;
  index.activeCount -= 1;
  index.totalTitleLen -= entry.titleLen;
  index.totalDescLen -= entry.descLen;
  index.totalBodyLen -= entry.bodyLen;
  index.idToSlot.delete(entry.id);
  if (entry.issueId) index.issueToSlots.get(entry.issueId)?.delete(slot);
}

function removeSync(index: WorkspaceSearchIndex, id: string): void {
  const slot = index.idToSlot.get(id);
  if (slot === undefined) return;
  markDeleted(index, slot);
}

function insertSync(index: WorkspaceSearchIndex, doc: SearchDocument): void {
  if (index.idToSlot.has(doc.id)) {
    removeSync(index, doc.id);
  }
  const titleText = sanitizeSearchText(doc.title);
  const descText = sanitizeSearchText(doc.description);
  const bodyText = sanitizeSearchText(doc.body);
  const titleCounts = tokenizeField(titleText);
  const descCounts = tokenizeField(descText);
  const bodyCounts = tokenizeField(bodyText);

  const slot = index.entries.length;
  const entry: IndexedEntry = {
    id: doc.id,
    kind: doc.kind ?? "",
    issueId: doc.issueId ?? "",
    teamId: doc.teamId ?? "",
    identifierLower: (doc.identifier ?? "").toLowerCase(),
    title: titleText.slice(0, MAX_STORED_TITLE_CHARS),
    status: doc.status ?? "",
    documentId: doc.documentId ?? "",
    memoryId: doc.memoryId ?? "",
    titleLen: tokenCount(titleCounts),
    descLen: tokenCount(descCounts),
    bodyLen: tokenCount(bodyCounts),
    deleted: false,
  };
  index.entries.push(entry);
  index.idToSlot.set(doc.id, slot);
  if (entry.issueId) {
    let slots = index.issueToSlots.get(entry.issueId);
    if (!slots) {
      slots = new Set();
      index.issueToSlots.set(entry.issueId, slots);
    }
    slots.add(slot);
  }
  index.activeCount += 1;
  index.totalTitleLen += entry.titleLen;
  index.totalDescLen += entry.descLen;
  index.totalBodyLen += entry.bodyLen;

  // Merge per-field term frequencies into a single packed posting per
  // token: title tf in bits 0-2, description in 3-5, body in 6-9.
  const tfs = new Map<string, number>();
  for (const [token, tf] of bodyCounts) {
    tfs.set(token, Math.min(tf, 15) << 6);
  }
  for (const [token, tf] of descCounts) {
    tfs.set(token, (tfs.get(token) ?? 0) | (Math.min(tf, 7) << 3));
  }
  for (const [token, tf] of titleCounts) {
    tfs.set(token, (tfs.get(token) ?? 0) | Math.min(tf, 7));
  }
  for (const [token, tfsPacked] of tfs) {
    addPosting(index, token, (slot << 10) | tfsPacked);
  }
}

export function insert(
  index: WorkspaceSearchIndex,
  doc: SearchDocument
): Promise<void> {
  insertSync(index, doc);
  return Promise.resolve();
}

export function insertMultiple(
  index: WorkspaceSearchIndex,
  docs: SearchDocument[]
): Promise<void> {
  for (const doc of docs) {
    insertSync(index, doc);
  }
  return Promise.resolve();
}

export function remove(index: WorkspaceSearchIndex, id: string): Promise<void> {
  removeSync(index, id);
  return Promise.resolve();
}

export async function removeIssueDocuments(
  index: WorkspaceSearchIndex,
  issueId: string
): Promise<void> {
  const slots = index.issueToSlots.get(issueId);
  if (!slots) return;
  for (const slot of slots) {
    markDeleted(index, slot);
  }
  index.issueToSlots.delete(issueId);
}

// ---- query side ----

function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of query.toLowerCase().matchAll(TOKEN_RE)) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    terms.push(match[0]);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

/** Levenshtein distance ≤ 1, computed without a full DP table. */
function withinEditDistanceOne(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff <= 1;
  }
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/** Vocabulary terms matching `term` — exact, plus edit-distance-1
 *  expansions when tolerance allows (only applied to terms ≥ 4 chars;
 *  shorter terms fuzz-match noise). */
function expandTerm(
  index: WorkspaceSearchIndex,
  term: string,
  tolerance: number
): string[] {
  const expanded: string[] = [];
  if (index.postings.has(term)) expanded.push(term);
  if (tolerance > 0 && term.length >= 4) {
    for (const token of index.postings.keys()) {
      if (token !== term && withinEditDistanceOne(term, token)) {
        expanded.push(token);
      }
    }
  }
  return expanded;
}

function bm25Tf(tf: number, docLen: number, avgDocLen: number): number {
  if (tf <= 0) return 0;
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / avgDocLen);
  return (tf * (BM25_K1 + 1)) / (tf + norm);
}

interface FieldBoosts {
  title: number;
  description: number;
  body: number;
}

/** BM25 scores per slot for a tokenized query. Tombstoned postings are
 *  skipped lazily — removal never rewrites posting lists. */
function scoreSlots(
  index: WorkspaceSearchIndex,
  query: string,
  boosts: FieldBoosts,
  tolerance: number,
  filter?: (entry: IndexedEntry) => boolean
): Map<number, number> {
  const scores = new Map<number, number>();
  const n = Math.max(index.activeCount, 1);
  const avgTitle = Math.max(index.totalTitleLen / n, 1);
  const avgDesc = Math.max(index.totalDescLen / n, 1);
  const avgBody = Math.max(index.totalBodyLen / n, 1);

  const scorePacked = (packed: number, idf: number) => {
    const slot = packed >>> 10;
    const entry = index.entries[slot];
    if (entry.deleted) return;
    if (filter && !filter(entry)) return;
    const bodyTf = (packed >>> 6) & 0x0f;
    const descTf = (packed >>> 3) & 0x07;
    const titleTf = packed & 0x07;
    const score =
      idf *
      (boosts.title * bm25Tf(titleTf, entry.titleLen, avgTitle) +
        boosts.description * bm25Tf(descTf, entry.descLen, avgDesc) +
        boosts.body * bm25Tf(bodyTf, entry.bodyLen, avgBody));
    if (score > 0) {
      scores.set(slot, (scores.get(slot) ?? 0) + score);
    }
  };

  for (const term of queryTerms(query)) {
    const expanded = expandTerm(index, term, tolerance);
    let df = 0;
    for (const token of expanded) {
      const posting = index.postings.get(token);
      df += typeof posting === "number" ? 1 : (posting?.length ?? 0);
    }
    if (df === 0) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    if (idf <= 0) continue;
    for (const token of expanded) {
      const posting = index.postings.get(token);
      if (posting === undefined) continue;
      if (typeof posting === "number") {
        scorePacked(posting, idf);
      } else {
        for (const packed of posting) scorePacked(packed, idf);
      }
    }
  }
  return scores;
}

function rankedSlots(scores: Map<number, number>): number[] {
  return [...scores.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([slot]) => slot);
}

// ---- document mappers ----

export function issueToSearchDocument(
  issue: Pick<
    Issue,
    "id" | "teamId" | "identifier" | "title" | "description" | "status"
  >
): SearchDocument {
  return {
    id: issue.id,
    kind: "issue",
    issueId: issue.id,
    teamId: issue.teamId,
    identifier: issue.identifier ?? "",
    title: sanitizeSearchText(issue.title),
    description: sanitizeSearchText(issue.description),
    body: "",
    status: issue.status,
    documentId: "",
  };
}

export interface CommentForSearch {
  id: string;
  issueId: string;
  teamId: string;
  body: string;
  createdAt: string;
}

export function commentToSearchDocument(
  comment: CommentForSearch
): SearchDocument {
  return {
    id: comment.id,
    kind: "comment",
    issueId: comment.issueId,
    teamId: comment.teamId,
    identifier: "",
    title: "",
    description: "",
    body: sanitizeSearchText(comment.body),
    status: "",
    documentId: "",
  };
}

export interface DocumentForSearch {
  id: string;
  title: string;
  content: string; // BlockNote JSON or Markdown; text is extracted for indexing
  createdAt: string;
}

function walkBlockNoteNodes(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node === "object" && node !== null) {
      const rec = node as Record<string, unknown>;
      if (typeof rec.text === "string") out.push(rec.text);
      if (Array.isArray(rec.content))
        out.push(...walkBlockNoteNodes(rec.content));
      if (Array.isArray(rec.children))
        out.push(...walkBlockNoteNodes(rec.children));
    }
  }
  return out;
}

export function blockNoteToPlainText(content: string): string {
  if (!content) return "";
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return sanitizeSearchText(walkBlockNoteNodes(parsed).join(" "));
    }
  } catch {
    // Markdown or plain-text document — index directly below.
  }
  return sanitizeSearchText(content);
}

export function documentToSearchDocument(
  doc: DocumentForSearch
): SearchDocument {
  return {
    id: doc.id,
    kind: "document",
    issueId: "",
    teamId: "",
    identifier: "",
    title: sanitizeSearchText(doc.title),
    description: "",
    body: blockNoteToPlainText(doc.content),
    status: "",
    documentId: doc.id,
  };
}

export interface MemoryForSearch {
  id: string;
  entityType: string;
  entityId: string;
  kind: string;
  fact: string;
  createdAt: string;
  /** Resolved workspace issue/team when the fact is attached to an issue —
   *  lets issue search and team scoping see it. */
  issueId?: string;
  teamId?: string;
}

export function memoryToSearchDocument(mem: MemoryForSearch): SearchDocument {
  return {
    id: `memory:${mem.id}`,
    kind: "memory",
    issueId: mem.issueId ?? "",
    teamId: mem.teamId ?? "",
    identifier: "",
    title: sanitizeSearchText(`${mem.entityType} ${mem.entityId} ${mem.kind}`),
    description: "",
    body: sanitizeSearchText(mem.fact),
    status: "",
    documentId: "",
    memoryId: mem.id,
  };
}

export async function indexDocumentSearchDocument(
  index: WorkspaceSearchIndex,
  doc: DocumentForSearch
) {
  await insert(index, documentToSearchDocument(doc));
}

export async function indexIssueDocument(
  index: WorkspaceSearchIndex,
  issue: Issue
) {
  await insert(index, issueToSearchDocument(issue));
}

export async function indexCommentDocument(
  index: WorkspaceSearchIndex,
  comment: CommentForSearch
) {
  await insert(index, commentToSearchDocument(comment));
}

export async function indexMemorySearchDocument(
  index: WorkspaceSearchIndex,
  mem: MemoryForSearch
) {
  await insert(index, memoryToSearchDocument(mem));
}

export async function removeMemorySearchDocument(
  index: WorkspaceSearchIndex,
  memoryId: string
) {
  await remove(index, `memory:${memoryId}`);
}

// ---- searches ----

export async function searchIssues(
  index: WorkspaceSearchIndex,
  query: string,
  teamIds: string[],
  limit = 1000
): Promise<string[]> {
  // Only issue-attached entries answer an issue query — documents and
  // unattached memories (issueId "") must not consume the result limit.
  const inScope = (entry: IndexedEntry) =>
    entry.issueId.length > 0 &&
    (teamIds.length === 0 || teamIds.includes(entry.teamId));
  const queryLower = query.toLowerCase().trim();

  // Identifier hits rank first — "VTX-123" or any substring of it should
  // surface the exact issue ahead of content matches.
  const out: string[] = [];
  const seen = new Set<string>();
  if (queryLower.length > 0) {
    for (const entry of index.entries) {
      if (entry.deleted || entry.identifierLower.length === 0) continue;
      if (!inScope(entry)) continue;
      if (
        entry.identifierLower === queryLower ||
        (queryLower.length >= 2 && entry.identifierLower.includes(queryLower))
      ) {
        const key = entry.issueId || entry.id;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
        if (out.length >= limit) return out;
      }
    }
  }

  const scores = scoreSlots(
    index,
    query,
    { title: 2, description: 1, body: 0.5 },
    1,
    inScope
  );
  for (const slot of rankedSlots(scores)) {
    const entry = index.entries[slot];
    const key = entry.issueId || entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchDocuments(
  index: WorkspaceSearchIndex,
  query: string,
  limit = 50
): Promise<string[]> {
  const scores = scoreSlots(
    index,
    query,
    { title: 2, description: 0, body: 1 },
    1,
    (entry) => entry.kind === "document"
  );
  const out: string[] = [];
  for (const slot of rankedSlots(scores)) {
    const documentId = index.entries[slot].documentId;
    if (!documentId) continue;
    out.push(documentId);
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchMemories(
  index: WorkspaceSearchIndex,
  query: string,
  limit = 50
): Promise<string[]> {
  const scores = scoreSlots(
    index,
    query,
    { title: 2, description: 0, body: 1 },
    1,
    (entry) => entry.kind === "memory"
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slot of rankedSlots(scores)) {
    const memoryId = index.entries[slot].memoryId;
    if (!memoryId || seen.has(memoryId)) continue;
    seen.add(memoryId);
    out.push(memoryId);
    if (out.length >= limit) break;
  }
  return out;
}

export interface SimilarIssueHit {
  issueId: string;
  score: number;
}

const SIMILAR_QUERY_MAX_TERMS = 24;

const SIMILAR_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "does",
  "from",
  "have",
  "into",
  "just",
  "more",
  "only",
  "should",
  "some",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
]);

/** Significant terms of an issue (title first, then description) used as the
 *  similarity query. Short words and stop words carry no signal for BM25. */
export function similarityTerms(
  title: string,
  description?: string | null
): string[] {
  const words = `${title}\n${description ?? ""}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4 && !SIMILAR_STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, SIMILAR_QUERY_MAX_TERMS);
}

/** Issues whose title/description best match the given issue's text, ranked
 *  by BM25. Comments and documents are not considered; the issue itself is
 *  excluded. */
export async function findSimilarIssues(
  index: WorkspaceSearchIndex,
  issue: Pick<Issue, "id" | "title" | "description">,
  teamIds: string[],
  limit = 10
): Promise<SimilarIssueHit[]> {
  const terms = similarityTerms(issue.title, issue.description);
  if (terms.length === 0) return [];
  const scores = scoreSlots(
    index,
    terms.join(" "),
    { title: 2, description: 1, body: 0 },
    0,
    (entry) =>
      entry.kind === "issue" &&
      (teamIds.length === 0 || teamIds.includes(entry.teamId))
  );
  const hits: SimilarIssueHit[] = [];
  for (const [slot, score] of [...scores.entries()].toSorted(
    (a, b) => b[1] - a[1]
  )) {
    const entry = index.entries[slot];
    const issueId = entry.issueId || entry.id;
    if (issueId === issue.id) continue;
    hits.push({ issueId, score });
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface DuplicateCandidateHit {
  issueId: string;
  score: number;
}

/** Minimum title overlap (see `titleOverlapScore`) for a possible duplicate. */
export const DUPLICATE_MIN_SCORE = 0.6;

const DUPLICATE_CANDIDATE_POOL = 50;

const CLOSED_STATUSES = new Set(["done", "canceled"]);

/** Share of significant title terms two titles have in common, in [0, 1]:
 *  shared terms over the larger term set, so 1 means the same terms. */
export function titleOverlapScore(a: string, b: string): number {
  const left = new Set(similarityTerms(a));
  const right = new Set(similarityTerms(b));
  const size = Math.max(left.size, right.size);
  if (size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / size;
}

/** Lowercase alphanumeric-only form of a title, for verbatim-match checks
 *  when a title has too few significant terms for the index to help. */
export function normalizeIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Open issues whose titles closely match `title`, best first. BM25 gathers
 *  candidates; `titleOverlapScore` ranks them and drops weak matches.
 *  Index rows may be stale — callers re-verify against storage and apply
 *  their own limit, so this returns the whole candidate pool. */
export async function findDuplicateCandidates(
  index: WorkspaceSearchIndex,
  title: string,
  teamIds: string[]
): Promise<DuplicateCandidateHit[]> {
  const terms = similarityTerms(title);
  if (terms.length === 0) return [];
  const scores = scoreSlots(
    index,
    terms.join(" "),
    { title: 1, description: 0, body: 0 },
    0,
    (entry) =>
      entry.kind === "issue" &&
      (teamIds.length === 0 || teamIds.includes(entry.teamId))
  );
  const hits: DuplicateCandidateHit[] = [];
  for (const slot of rankedSlots(scores).slice(0, DUPLICATE_CANDIDATE_POOL)) {
    const entry = index.entries[slot];
    if (CLOSED_STATUSES.has(entry.status)) continue;
    const score = titleOverlapScore(title, entry.title);
    if (score < DUPLICATE_MIN_SCORE) continue;
    hits.push({ issueId: entry.issueId || entry.id, score });
  }
  return hits.toSorted((a, b) => b.score - a.score);
}
