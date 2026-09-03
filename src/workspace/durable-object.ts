import { DurableObject } from "cloudflare:workers";
import { and, desc, eq, like, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { createIssueHistory } from "../global/issue-history.js";
import { getWorkspaceById } from "../global/workspaces.js";
import type { AppEnv } from "../types/env.js";
import type {
  Issue,
  IssueInput,
  ListIssuesArgs,
  RealtimeEvent,
} from "../types/workspace.js";
import { workspaceMigrations } from "./migrations.js";
import { workspaceIssues } from "./schema.js";
import { deliverWebhooks } from "./webhooks.js";

type IssueKey = keyof Issue & keyof IssueInput;

export class WorkspaceDO extends DurableObject<AppEnv> {
  private workspaceId: string;
  private readonly ready: Promise<void>;
  private readonly db = drizzle(this.ctx.storage, {
    schema: { workspaceIssues },
  });

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.workspaceId = ctx.id.toString();
    this.ready = this.runMigrations();
  }

  async setWorkspaceId(id: string) {
    this.workspaceId = id;
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
      workspaceId: this.workspaceId,
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

  private async emit(event: RealtimeEvent) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // socket may be closing
      }
    }
    this.ctx.waitUntil(deliverWebhooks(this.env, this.workspaceId, event));
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
        createIssueHistory(db, this.workspaceId, {
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

    const d1 = createD1(this.env.D1);
    const workspace = await getWorkspaceById(d1, this.workspaceId);
    let number: number | null = null;
    let identifier: string | null = null;
    if (workspace?.key) {
      const last = await this.db
        .select({ number: sql<number | null>`MAX(number)` })
        .from(workspaceIssues)
        .get();
      number = (last?.number ?? 0) + 1;
      identifier = `${workspace.key}-${number}`;
    }

    const issue = await this.db
      .insert(workspaceIssues)
      .values({
        id,
        workspaceId: this.workspaceId,
        title: input.title,
        description: input.description ?? null,
        status,
        priority,
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

    await this.emit({
      type: "issue.created",
      workspaceId: this.workspaceId,
      issue,
    });
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

  async listIssues(args: ListIssuesArgs = {}): Promise<Issue[]> {
    await this.ready;
    const conditions = [];

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
    if (args.search) {
      const pattern = `%${args.search}%`;
      conditions.push(
        or(
          like(workspaceIssues.title, pattern),
          like(sql`COALESCE(${workspaceIssues.description}, '')`, pattern)
        )
      );
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

    const set: Partial<Issue> = {
      updatedAt: new Date().toISOString(),
    };

    const allowed: Array<{ key: IssueKey; field: string }> = [
      { key: "title", field: "title" },
      { key: "description", field: "description" },
      { key: "status", field: "status" },
      { key: "priority", field: "priority" },
      { key: "assigneeId", field: "assignee_id" },
      { key: "projectId", field: "project_id" },
      { key: "cycleId", field: "cycle_id" },
      { key: "labelIds", field: "label_ids" },
      { key: "repo", field: "repo" },
      { key: "branch", field: "branch" },
    ];

    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.priority !== undefined) set.priority = patch.priority;
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

    await this.emit({
      type: "issue.updated",
      workspaceId: this.workspaceId,
      issue,
    });
    return issue;
  }

  async deleteIssue(id: string): Promise<boolean> {
    await this.ready;
    const deleted = await this.db
      .delete(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .returning()
      .get();
    if (!deleted) return false;
    await this.emit({
      type: "issue.deleted",
      workspaceId: this.workspaceId,
      issueId: id,
    });
    return true;
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
      workspaceId: this.workspaceId,
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
      workspaceId: this.workspaceId,
      issue,
    });
    return issue;
  }
}
