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
    createdAt: timestampToNumber(issue.createdAt),
  };
}

export interface CommentForSearch {
  id: string;
  issueId: string;
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
    createdAt: timestampToNumber(comment.createdAt),
  };
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
  limit = 1000
): Promise<string[]> {
  const [identifierResult, contentResult] = await Promise.all([
    search(index, {
      term: query,
      properties: ["identifier"],
      limit,
      exact: true,
      tolerance: 0,
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
