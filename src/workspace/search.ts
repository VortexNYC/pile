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
  kind: "string",
  issueId: "string",
  teamId: "string",
  identifier: "string",
  title: "string",
  description: "string",
  body: "string",
  status: "string",
  priority: "string",
  assigneeId: "string",
  projectId: "string",
  cycleId: "string",
  labelIds: "string",
  documentId: "string",
  createdAt: "number",
} as const;

export type WorkspaceSearchIndex = Orama<typeof searchSchema>;
export type SearchDocument = TypedDocument<WorkspaceSearchIndex>;

export function createWorkspaceSearchIndex(): WorkspaceSearchIndex {
  return create({ schema: searchSchema });
}

function timestampToNumber(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function issueToSearchDocument(issue: Issue): SearchDocument {
  return {
    id: issue.id,
    kind: "issue",
    issueId: issue.id,
    teamId: issue.teamId,
    identifier: issue.identifier ?? "",
    title: issue.title,
    description: issue.description ?? "",
    body: "",
    status: issue.status,
    priority: issue.priority,
    assigneeId: issue.assigneeId ?? "",
    projectId: issue.projectId ?? "",
    cycleId: issue.cycleId ?? "",
    labelIds: issue.labelIds ?? "",
    documentId: "",
    createdAt: timestampToNumber(issue.createdAt),
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
    body: comment.body,
    status: "",
    priority: "",
    assigneeId: "",
    projectId: "",
    cycleId: "",
    labelIds: "",
    documentId: "",
    createdAt: timestampToNumber(comment.createdAt),
  };
}

export interface DocumentForSearch {
  id: string;
  title: string;
  content: string; // BlockNote JSON; text is extracted for indexing
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
  try {
    return walkBlockNoteNodes(
      JSON.parse(content) as Array<Record<string, unknown>>
    ).join(" ");
  } catch {
    return "";
  }
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
    title: doc.title,
    description: "",
    body: blockNoteToPlainText(doc.content),
    status: "",
    priority: "",
    assigneeId: "",
    projectId: "",
    cycleId: "",
    labelIds: "",
    documentId: doc.id,
    createdAt: timestampToNumber(doc.createdAt),
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
  await insert(index, commentToSearchDocument(comment));
}

export async function removeIssueDocuments(
  index: WorkspaceSearchIndex,
  issueId: string
) {
  const result = await search(index, {
    where: { issueId },
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
  const where = teamIds.length > 0 ? { teamId: teamIds } : undefined;
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
    ids.add(doc.issueId || doc.id);
  }
  for (const hit of contentResult.hits) {
    const doc = hit.document as SearchDocument;
    ids.add(doc.issueId || doc.id);
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
    where: { kind: "document" },
    limit,
  });
  return result.hits.map((hit) => hit.document.documentId);
}
