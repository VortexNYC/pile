import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { createIssueHistory } from "../global/issue-history.js";
import {
  notifyCommentCreated,
  notifyIssueCreated,
  notifyIssueDeleted,
  notifyIssueUpdated,
} from "../global/notify-issue.js";
import { comments } from "../global/schema.js";
import { getDefaultTeam, getTeamById } from "../global/teams.js";
import { getWorkspaceById } from "../global/workspaces.js";
import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import {
  ISSUE_RESOLUTIONS,
  type Comment,
  type Issue,
  type IssueInput,
  type IssueResolution,
  type IssueStatus,
  type ListIssuesArgs,
  type RealtimeEvent,
} from "../types/workspace.js";
import { filterToSql } from "./filter.js";
import { workspaceMigrations } from "./migrations.js";
import { workspaceIssues } from "./schema.js";
import {
  commentToSearchDocument,
  createWorkspaceSearchIndex,
  indexCommentDocument,
  indexIssueDocument,
  insertMultiple as insertSearchDocs,
  issueToSearchDocument,
  removeIssueDocuments,
  searchIssues,
  type CommentForSearch,
  type WorkspaceSearchIndex,
} from "./search.js";
import { deliverWebhooks, retryWebhookDeliveries } from "./webhooks.js";

type IssueKey = keyof Issue & keyof IssueInput;

const TERMINAL_STATUSES: ReadonlyArray<IssueStatus> = ["done", "canceled"];

function validateIssueResolution(
  status: IssueStatus,
  resolution: IssueResolution | null
): IssueResolution | null {
  if (resolution === null) return null;
  if (!ISSUE_RESOLUTIONS.some((r) => r === resolution)) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      `Invalid issue resolution: ${resolution}`
    );
  }
  if (!TERMINAL_STATUSES.some((s) => s === status)) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      `Resolution can only be set when status is done or canceled, got ${status}`
    );
  }
  return resolution;
}

export class WorkspaceDO extends DurableObject<AppEnv> {
  private organizationId: string;
  private readonly ready: Promise<void>;
  private searchIndex: WorkspaceSearchIndex | null = null;
  private readonly db = drizzle(this.ctx.storage, {
    schema: { workspaceIssues },
  });

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.organizationId = ctx.id.toString();
    this.ready = this.initialize();
  }

  private async initialize() {
    const [stored] = await Promise.all([
      this.ctx.storage.get<string>("organizationId"),
      this.runMigrations(),
    ]);
    if (stored) {
      this.organizationId = stored;
    }
  }

  async setOrganizationId(id: string) {
    this.organizationId = id;
    await this.ctx.storage.put("organizationId", id);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("WorkspaceDO");
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(client);

    await this.emit({
      type: "connected",
      organizationId: this.organizationId,
    });

    return new Response(null, {
      status: 101,
      webSocket: server,
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const parsed = z
        .object({ type: z.string() })
        .safeParse(JSON.parse(message));
      if (parsed.success && parsed.data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  private async runMigrations() {
    await migrate(this.db, workspaceMigrations);
  }

  private async ensureSearchIndex() {
    if (this.searchIndex) return this.searchIndex;

    const index = await createWorkspaceSearchIndex();
    const [issues, commentRows] = await Promise.all([
      this.db.select().from(workspaceIssues).all(),
      createD1(this.env.D1)
        .select({
          id: comments.id,
          issueId: comments.issueId,
          body: comments.body,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(eq(comments.organizationId, this.organizationId))
        .all(),
    ]);

    const issueById = new Map(issues.map((issue) => [issue.id, issue]));
    const docs: Array<ReturnType<typeof issueToSearchDocument>> = [];
    for (const issue of issues) {
      docs.push(issueToSearchDocument(issue));
    }
    for (const comment of commentRows) {
      const issue = issueById.get(comment.issueId);
      docs.push(
        commentToSearchDocument({
          id: comment.id,
          issueId: comment.issueId,
          teamId: issue?.teamId ?? "",
          body: comment.body,
          createdAt: comment.createdAt,
        })
      );
    }
    if (docs.length > 0) {
      await insertSearchDocs(index, docs);
    }

    this.searchIndex = index;
    return index;
  }

  private async emit(event: RealtimeEvent) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // socket may be closing
      }
    }
    this.ctx.waitUntil(this.sendWebhookEvent(event));
  }

  private async sendWebhookEvent(event: RealtimeEvent) {
    const result = await deliverWebhooks(this.env, this.organizationId, event);
    if (result.needsRetry && result.retryAt) {
      await this.ctx.storage.setAlarm(result.retryAt);
    }
  }

  async alarm() {
    const result = await retryWebhookDeliveries(this.env, this.organizationId);
    if (result.hasMore && result.retryAt) {
      await this.ctx.storage.setAlarm(result.retryAt);
    }
  }

  private async recordIssueHistory(
    issueId: string,
    entries: ReadonlyArray<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }>,
    actorId?: string
  ) {
    const db = createD1(this.env.D1);
    await Promise.all(
      entries.map((entry) =>
        createIssueHistory(db, this.organizationId, {
          issueId,
          linearId: null,
          actorId: actorId ?? null,
          ...entry,
        })
      )
    );
  }

  async createIssue(input: IssueInput, actorId?: string): Promise<Issue> {
    await this.ready;
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const status = input.status ?? "backlog";
    const priority = input.priority ?? "medium";
    const resolution = validateIssueResolution(
      status,
      input.resolution ?? null
    );

    const d1 = createD1(this.env.D1);
    const workspace = await getWorkspaceById(d1, this.organizationId);
    const team = input.teamId
      ? await getTeamById(d1, input.teamId, this.organizationId)
      : await getDefaultTeam(d1, this.organizationId);
    if (!team) {
      throw new Error(
        input.teamId ? "Team not found" : "Workspace has no default team"
      );
    }

    const key = team.key || workspace?.key || "general";
    const last = await this.db
      .select({ number: sql<number | null>`MAX(number)` })
      .from(workspaceIssues)
      .where(eq(workspaceIssues.teamId, team.id))
      .get();
    const number = (last?.number ?? 0) + 1;
    const identifier = `${key}-${number}`;

    const issue = await this.db
      .insert(workspaceIssues)
      .values({
        id,
        organizationId: this.organizationId,
        teamId: team.id,
        title: input.title,
        description: input.description ?? null,
        status,
        priority,
        resolution,
        assigneeId: input.assigneeId ?? null,
        projectId: input.projectId ?? null,
        cycleId: input.cycleId ?? null,
        labelIds: input.labelIds ?? null,
        number,
        identifier,
        repo: input.repo ?? null,
        branch: input.branch ?? null,
        prUrl: null,
        prState: null,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      })
      .returning()
      .get();

    if (!issue) {
      throw new Error("Failed to create issue");
    }

    const index = await this.ensureSearchIndex();
    await indexIssueDocument(index, issue);

    await this.emit({
      type: "issue.created",
      organizationId: this.organizationId,
      issue,
    });
    this.ctx.waitUntil(
      notifyIssueCreated(this.env, this.organizationId, issue, actorId)
    );
    await this.recordIssueHistory(
      issue.id,
      [{ field: "created", fromValue: null, toValue: issue.title }],
      actorId
    );
    return issue;
  }

  async getIssue(id: string): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .get();
  }

  async getIssueByBranch(
    repo: string,
    branch: string
  ): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(
        and(eq(workspaceIssues.repo, repo), eq(workspaceIssues.branch, branch))
      )
      .get();
  }

  async indexComment(comment: CommentForSearch) {
    await this.ready;
    const index = await this.ensureSearchIndex();
    await indexCommentDocument(index, comment);
  }

  async listIssues(args: ListIssuesArgs = {}): Promise<Issue[]> {
    await this.ready;
    const conditions = [];

    const visibleTeamIds =
      args.teamIds && args.teamIds.length > 0 ? args.teamIds : undefined;

    if (visibleTeamIds) {
      conditions.push(inArray(workspaceIssues.teamId, visibleTeamIds));
    }
    if (args.teamId) {
      conditions.push(eq(workspaceIssues.teamId, args.teamId));
    }
    if (args.status) {
      conditions.push(eq(workspaceIssues.status, args.status));
    }
    if (args.priority) {
      conditions.push(eq(workspaceIssues.priority, args.priority));
    }
    if (args.assigneeId) {
      conditions.push(eq(workspaceIssues.assigneeId, args.assigneeId));
    }
    if (args.projectId) {
      conditions.push(eq(workspaceIssues.projectId, args.projectId));
    }
    if (args.cycleId) {
      conditions.push(eq(workspaceIssues.cycleId, args.cycleId));
    }
    if (args.labelId) {
      conditions.push(
        like(
          sql`',' || COALESCE(${workspaceIssues.labelIds}, '') || ','`,
          `%,${args.labelId},%`
        )
      );
    }
    if (args.filter) {
      conditions.push(filterToSql(args.filter));
    }
    if (args.search) {
      const index = await this.ensureSearchIndex();
      const issueIds = await searchIssues(
        index,
        args.search,
        visibleTeamIds ?? [],
        args.limit
      );
      if (issueIds.length === 0) {
        return [];
      }
      conditions.push(inArray(workspaceIssues.id, issueIds));
    }
    if (args.cursor) {
      conditions.push(
        or(
          lt(workspaceIssues.createdAt, args.cursor.createdAt),
          and(
            eq(workspaceIssues.createdAt, args.cursor.createdAt),
            lt(workspaceIssues.id, args.cursor.id)
          )
        )
      );
    }

    const limit = args.limit ?? 1_000_000;
    const query = this.db
      .select()
      .from(workspaceIssues)
      .orderBy(desc(workspaceIssues.createdAt), desc(workspaceIssues.id))
      .limit(limit);

    const rows = conditions.length
      ? query.where(and(...conditions)).all()
      : query.all();

    return rows;
  }

  async updateIssue(
    id: string,
    patch: Partial<IssueInput>,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssue(id);
    if (!old) return undefined;

    const newStatus = patch.status ?? old.status;
    const newResolution =
      patch.resolution !== undefined
        ? patch.resolution
        : patch.status !== undefined && newStatus !== old.status
          ? null
          : old.resolution;
    const resolvedResolution = validateIssueResolution(
      newStatus,
      newResolution
    );

    const set: Partial<Issue> = {
      updatedAt: new Date().toISOString(),
    };

    const allowed: Array<{ key: IssueKey; field: string }> = [
      { key: "teamId", field: "team_id" },
      { key: "title", field: "title" },
      { key: "description", field: "description" },
      { key: "status", field: "status" },
      { key: "priority", field: "priority" },
      { key: "resolution", field: "resolution" },
      { key: "assigneeId", field: "assignee_id" },
      { key: "projectId", field: "project_id" },
      { key: "cycleId", field: "cycle_id" },
      { key: "labelIds", field: "label_ids" },
      { key: "repo", field: "repo" },
      { key: "branch", field: "branch" },
    ];

    if (patch.teamId !== undefined && patch.teamId !== old.teamId) {
      const d1 = createD1(this.env.D1);
      const team = await getTeamById(d1, patch.teamId, this.organizationId);
      if (!team) {
        throw new Error("Team not found");
      }
      const last = await this.db
        .select({ number: sql<number | null>`MAX(number)` })
        .from(workspaceIssues)
        .where(eq(workspaceIssues.teamId, team.id))
        .get();
      const number = (last?.number ?? 0) + 1;
      set.teamId = team.id;
      set.number = number;
      set.identifier = `${team.key}-${number}`;
    }
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.resolution !== undefined || patch.status !== undefined) {
      set.resolution = resolvedResolution;
    }
    if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
    if (patch.projectId !== undefined) set.projectId = patch.projectId;
    if (patch.cycleId !== undefined) set.cycleId = patch.cycleId;
    if (patch.labelIds !== undefined) set.labelIds = patch.labelIds;
    if (patch.repo !== undefined) set.repo = patch.repo;
    if (patch.branch !== undefined) set.branch = patch.branch;

    if (Object.keys(set).length === 1 && "updatedAt" in set) {
      return old;
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(eq(workspaceIssues.id, id))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries = allowed
      .filter(({ key }) => key in patch)
      .map(({ key, field }) => {
        const before = old[key];
        const after = issue[key];
        const fromValue = before === null ? null : String(before);
        const toValue = after === null ? null : String(after);
        return fromValue === toValue
          ? undefined
          : { field, fromValue, toValue };
      })
      .filter(
        (
          entry
        ): entry is {
          field: string;
          fromValue: string | null;
          toValue: string | null;
        } => entry !== undefined
      );

    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    const index = await this.ensureSearchIndex();
    await indexIssueDocument(index, issue);

    await this.emit({
      type: "issue.updated",
      organizationId: this.organizationId,
      issue,
    });
    this.ctx.waitUntil(
      notifyIssueUpdated(this.env, this.organizationId, issue, actorId)
    );
    return issue;
  }

  async deleteIssue(id: string, actorId?: string): Promise<boolean> {
    await this.ready;
    const old = await this.getIssue(id);
    const deleted = await this.db
      .delete(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .returning()
      .get();
    if (!deleted) return false;

    const index = await this.ensureSearchIndex();
    await removeIssueDocuments(index, id);

    await this.emit({
      type: "issue.deleted",
      organizationId: this.organizationId,
      issueId: id,
    });
    if (old) {
      this.ctx.waitUntil(
        notifyIssueDeleted(this.env, this.organizationId, old, actorId)
      );
    }
    return true;
  }

  async emitCommentCreated(
    comment: Comment,
    issue: Issue,
    actorId?: string
  ): Promise<void> {
    await this.ready;
    await this.emit({
      type: "comment.created",
      organizationId: this.organizationId,
      issue,
      comment,
    });
    await notifyCommentCreated(this.env, this.organizationId, issue, actorId);
  }

  async emitCommentUpdated(comment: Comment, issue: Issue): Promise<void> {
    await this.ready;
    await this.emit({
      type: "comment.updated",
      organizationId: this.organizationId,
      issue,
      comment,
    });
  }

  async emitCommentDeleted(commentId: string, issueId: string): Promise<void> {
    await this.ready;
    await this.emit({
      type: "comment.deleted",
      organizationId: this.organizationId,
      issueId,
      commentId,
    });
  }

  async getIssueByIdentifier(identifier: string): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.identifier, identifier))
      .get();
  }

  async updatePrByIdentifier(
    identifier: string,
    prUrl: string,
    prState: string,
    repo: string,
    branch: string,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssueByIdentifier(identifier);
    if (!old) return undefined;

    const statusMap: Record<string, Issue["status"] | undefined> = {
      draft: "backlog",
      open: "in_progress",
      merged: "done",
      closed: "canceled",
    };
    const status = statusMap[prState];
    const set: {
      prUrl: string;
      prState: string;
      updatedAt: string;
      status?: Issue["status"];
      repo?: string;
      branch?: string;
    } = {
      prUrl,
      prState,
      updatedAt: new Date().toISOString(),
    };
    if (status !== undefined) {
      set.status = status;
    }
    if (old.repo === null) {
      set.repo = repo;
    }
    if (old.branch === null) {
      set.branch = branch;
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(eq(workspaceIssues.identifier, identifier))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];
    if (old.prUrl !== issue.prUrl) {
      historyEntries.push({
        field: "pr_url",
        fromValue: old.prUrl,
        toValue: issue.prUrl,
      });
    }
    if (old.prState !== issue.prState) {
      historyEntries.push({
        field: "pr_state",
        fromValue: old.prState,
        toValue: issue.prState,
      });
    }
    if (old.status !== issue.status) {
      historyEntries.push({
        field: "status",
        fromValue: old.status,
        toValue: issue.status,
      });
    }
    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    await this.emit({
      type: "pr.updated",
      organizationId: this.organizationId,
      issue,
    });
    return issue;
  }

  async updatePrState(
    repo: string,
    branch: string,
    prUrl: string,
    prState: string,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssueByBranch(repo, branch);
    if (!old) return undefined;

    const statusMap: Record<string, Issue["status"] | undefined> = {
      draft: "backlog",
      open: "in_progress",
      merged: "done",
      closed: "canceled",
    };
    const status = statusMap[prState];
    const set: {
      prUrl: string;
      prState: string;
      updatedAt: string;
      status?: Issue["status"];
    } = {
      prUrl,
      prState,
      updatedAt: new Date().toISOString(),
    };
    if (status !== undefined) {
      set.status = status;
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(
        and(eq(workspaceIssues.repo, repo), eq(workspaceIssues.branch, branch))
      )
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];
    if (old.prUrl !== issue.prUrl) {
      historyEntries.push({
        field: "pr_url",
        fromValue: old.prUrl,
        toValue: issue.prUrl,
      });
    }
    if (old.prState !== issue.prState) {
      historyEntries.push({
        field: "pr_state",
        fromValue: old.prState,
        toValue: issue.prState,
      });
    }
    if (old.status !== issue.status) {
      historyEntries.push({
        field: "status",
        fromValue: old.status,
        toValue: issue.status,
      });
    }
    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    await this.emit({
      type: "pr.updated",
      organizationId: this.organizationId,
      issue,
    });
    return issue;
  }
}
