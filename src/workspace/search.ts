import {
  create,
  insert,
  insertMultiple,
  remove,
  search,
  type Orama,
  type TypedDocument,
} from "@orama/orama";

import type { Issue } from "../types/workspace.js";

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
} as const;

export type WorkspaceSearchIndex = Orama<typeof searchSchema>;
export type SearchDocument = TypedDocument<WorkspaceSearchIndex>;

export function createWorkspaceSearchIndex(): WorkspaceSearchIndex {
  return create({ schema: searchSchema, sort: { enabled: false } });
}

const MAX_SEARCH_TEXT_CHARS = 32_768;
const MAX_SEARCH_TOKEN_CHARS = 256;

/** Bound text length and single-token length before handing to Orama:
 *  Orama's replaceDiacritics calls `String.fromCharCode(...charCodes)` per
 *  token, which throws `RangeError: Maximum call stack size exceeded` in V8
 *  when a single contiguous token exceeds ~65k characters (VTX-649). */
export function sanitizeSearchText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .slice(0, MAX_SEARCH_TEXT_CHARS)
    .replace(/\S{256,}/g, (token) => token.slice(0, MAX_SEARCH_TOKEN_CHARS));
}

export function issueToSearchDocument(issue: Issue): SearchDocument {
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

export async function indexDocumentSearchDocument(
  index: WorkspaceSearchIndex,
  doc: DocumentForSearch
) {
  try {
    await remove(index, doc.id);
  } catch {
    // Document may not exist; ignore.
  }
  await insert(index, documentToSearchDocument(doc));
}

export async function indexIssueDocument(
  index: WorkspaceSearchIndex,
  issue: Issue
) {
  try {
    await remove(index, issue.id);
  } catch {
    // Document may not exist; ignore.
  }
  await insert(index, issueToSearchDocument(issue));
}

export async function indexCommentDocument(
  index: WorkspaceSearchIndex,
  comment: CommentForSearch
) {
  try {
    await remove(index, comment.id);
  } catch {
    // Document may not exist; ignore.
  }
  await insert(index, commentToSearchDocument(comment));
}

export async function removeIssueDocuments(
  index: WorkspaceSearchIndex,
  issueId: string
) {
  const result = await search(index, {
    where: { issueId: { eq: issueId } },
    limit: 1000,
  });
  await Promise.all(result.hits.map((hit) => remove(index, hit.id)));
}

export async function searchIssues(
  index: WorkspaceSearchIndex,
  query: string,
  teamIds: string[],
  limit = 1000
): Promise<string[]> {
  const where = teamIds.length > 0 ? { teamId: { in: teamIds } } : undefined;
  const [identifierResult, contentResult] = await Promise.all([
    search(index, {
      term: query,
      properties: ["identifier"],
      limit,
      exact: true,
      tolerance: 0,
      where,
    }),
    search(index, {
      term: query,
      properties: ["title", "description", "body"],
      limit,
      tolerance: 1,
      boost: {
        title: 2,
        description: 1,
        body: 0.5,
      },
      where,
    }),
  ]);

  const ids = new Set<string>();
  for (const hit of identifierResult.hits) {
    const doc = hit.document as SearchDocument;
    ids.add(String(doc.issueId || doc.id));
  }
  for (const hit of contentResult.hits) {
    const doc = hit.document as SearchDocument;
    ids.add(String(doc.issueId || doc.id));
  }
  return [...ids];
}

export { insertMultiple };

export async function searchDocuments(
  index: WorkspaceSearchIndex,
  query: string,
  limit = 50
): Promise<string[]> {
  const result = await search(index, {
    term: query,
    where: { kind: { eq: "document" } },
    limit,
  });
  return result.hits.map((hit) => String(hit.document.documentId));
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
  const result = await search(index, {
    term: terms.join(" "),
    properties: ["title", "description"],
    boost: { title: 2, description: 1 },
    tolerance: 0,
    where:
      teamIds.length > 0
        ? { kind: { eq: "issue" }, teamId: { in: teamIds } }
        : { kind: { eq: "issue" } },
    limit: limit + 1,
  });
  const hits: SimilarIssueHit[] = [];
  for (const hit of result.hits) {
    const doc = hit.document as SearchDocument;
    const issueId = String(doc.issueId || doc.id);
    if (issueId === issue.id) continue;
    hits.push({ issueId, score: hit.score });
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
  const result = await search(index, {
    term: terms.join(" "),
    properties: ["title"],
    tolerance: 0,
    where:
      teamIds.length > 0
        ? { kind: { eq: "issue" }, teamId: { in: teamIds } }
        : { kind: { eq: "issue" } },
    limit: DUPLICATE_CANDIDATE_POOL,
  });
  const hits: DuplicateCandidateHit[] = [];
  for (const hit of result.hits) {
    const doc = hit.document as SearchDocument;
    if (CLOSED_STATUSES.has(String(doc.status))) continue;
    const score = titleOverlapScore(title, doc.title);
    if (score < DUPLICATE_MIN_SCORE) continue;
    hits.push({ issueId: String(doc.issueId || doc.id), score });
  }
  return hits.toSorted((a, b) => b.score - a.score);
}
