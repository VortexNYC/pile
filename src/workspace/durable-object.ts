import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { deliverWebhooks } from "../agents/webhooks.js";
import type { AppEnv } from "../platform/env.js";
import { execAll, execOne } from "./sql.js";
import type {
  Issue,
  IssueInput,
  ListIssuesArgs,
  RealtimeEvent,
} from "./types.js";

const issueSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(["backlog", "todo", "in_progress", "done", "canceled"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  assignee_id: z.string().nullable(),
  project_id: z.string().nullable(),
  cycle_id: z.string().nullable(),
  label_ids: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  pr_url: z.string().nullable(),
  pr_state: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee_id TEXT,
        project_id TEXT,
        cycle_id TEXT,
        label_ids TEXT,
        repo TEXT,
        branch TEXT,
        pr_url TEXT,
        pr_state TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_issues_workspace_status
       ON issues (status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_issues_repo_branch
       ON issues (repo, branch)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_issues_created_at_id
       ON issues (created_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_issues_priority
       ON issues (priority, created_at DESC)`,
    ],
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export class WorkspaceDO extends DurableObject<AppEnv> {
  private readonly sql: SqlStorage;
  private workspaceId: string;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
    const current = (await this.ctx.storage.get<number>("schemaVersion")) ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        for (const statement of migration.statements) {
          this.sql.exec(statement);
        }
      }
    }
    await this.ctx.storage.put("schemaVersion", LATEST_SCHEMA_VERSION);
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

  async createIssue(input: IssueInput): Promise<Issue> {
    await this.ready;
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const status = input.status ?? "backlog";
    const priority = input.priority ?? "medium";

    const cursor = this.sql.exec(
      `INSERT INTO issues
        (id, workspace_id, title, description, status, priority, assignee_id, project_id, cycle_id, label_ids, repo, branch, pr_url, pr_state, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      id,
      this.workspaceId,
      input.title,
      input.description ?? null,
      status,
      priority,
      input.assigneeId ?? null,
      input.projectId ?? null,
      input.cycleId ?? null,
      input.labelIds ?? null,
      input.repo ?? null,
      input.branch ?? null,
      null,
      null,
      input.createdAt ?? now,
      input.updatedAt ?? now
    );

    const rows = Array.from(cursor);
    const parsed = issueSchema.safeParse(rows[0]);
    if (!parsed.success) {
      throw new Error("Failed to create issue: invalid row shape");
    }

    const issue = toIssue(parsed.data);
    await this.emit({
      type: "issue.created",
      workspaceId: this.workspaceId,
      issue,
    });
    return issue;
  }

  async getIssue(id: string): Promise<Issue | undefined> {
    await this.ready;
    const row = execOne(
      this.sql,
      issueSchema,
      "SELECT * FROM issues WHERE id = ?",
      id
    );
    return row ? toIssue(row) : undefined;
  }

  async getIssueByBranch(
    repo: string,
    branch: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const row = execOne(
      this.sql,
      issueSchema,
      "SELECT * FROM issues WHERE repo = ? AND branch = ?",
      repo,
      branch
    );
    return row ? toIssue(row) : undefined;
  }

  async listIssues(args: ListIssuesArgs = {}): Promise<Issue[]> {
    await this.ready;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.status) {
      conditions.push("status = ?");
      params.push(args.status);
    }
    if (args.priority) {
      conditions.push("priority = ?");
      params.push(args.priority);
    }
    if (args.assigneeId) {
      conditions.push("assignee_id = ?");
      params.push(args.assigneeId);
    }
    if (args.projectId) {
      conditions.push("project_id = ?");
      params.push(args.projectId);
    }
    if (args.cycleId) {
      conditions.push("cycle_id = ?");
      params.push(args.cycleId);
    }
    if (args.labelId) {
      conditions.push(
        "',' || COALESCE(label_ids, '') || ',' LIKE '%,' || ? || ',%'"
      );
      params.push(args.labelId);
    }
    if (args.search) {
      conditions.push("(title LIKE ? OR COALESCE(description, '') LIKE ?)");
      const pattern = `%${args.search}%`;
      params.push(pattern, pattern);
    }
    if (args.cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(args.cursor.createdAt, args.cursor.createdAt, args.cursor.id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = args.limit ?? 1_000_000;
    const query = `SELECT * FROM issues ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(limit);

    const rows = execAll(this.sql, issueSchema, query, ...params);
    return rows.map(toIssue);
  }

  async updateIssue(
    id: string,
    patch: Partial<IssueInput>
  ): Promise<Issue | undefined> {
    await this.ready;
    const allowed: Array<{
      key: keyof IssueInput;
      column: string;
    }> = [
      { key: "title", column: "title" },
      { key: "description", column: "description" },
      { key: "status", column: "status" },
      { key: "priority", column: "priority" },
      { key: "assigneeId", column: "assignee_id" },
      { key: "projectId", column: "project_id" },
      { key: "cycleId", column: "cycle_id" },
      { key: "labelIds", column: "label_ids" },
      { key: "repo", column: "repo" },
      { key: "branch", column: "branch" },
    ];

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const { key, column } of allowed) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }

    if (sets.length === 0) {
      return this.getIssue(id);
    }

    values.push(new Date().toISOString(), id);
    const query = `UPDATE issues SET ${sets.join(
      ", "
    )}, updated_at = ? WHERE id = ? RETURNING *`;
    const row = execOne(this.sql, issueSchema, query, ...values);
    if (!row) return undefined;
    const issue = toIssue(row);
    await this.emit({
      type: "issue.updated",
      workspaceId: this.workspaceId,
      issue,
    });
    return issue;
  }

  async deleteIssue(id: string): Promise<boolean> {
    await this.ready;
    Array.from(this.sql.exec("DELETE FROM issues WHERE id = ?", id));
    const cursor = this.sql.exec("SELECT changes() AS changes");
    const rows = Array.from(cursor) as Array<{ changes: number }>;
    const deleted = rows.length > 0 && rows[0].changes > 0;
    if (!deleted) return false;
    await this.emit({
      type: "issue.deleted",
      workspaceId: this.workspaceId,
      issueId: id,
    });
    return true;
  }

  async updatePrState(
    repo: string,
    branch: string,
    prUrl: string,
    prState: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const query = `UPDATE issues SET pr_url = ?, pr_state = ?, updated_at = ? WHERE repo = ? AND branch = ? RETURNING *`;
    const row = execOne(
      this.sql,
      issueSchema,
      query,
      prUrl,
      prState,
      new Date().toISOString(),
      repo,
      branch
    );
    if (!row) return undefined;
    const issue = toIssue(row);
    await this.emit({
      type: "pr.updated",
      workspaceId: this.workspaceId,
      issue,
    });
    return issue;
  }
}

function toIssue(row: z.infer<typeof issueSchema>): Issue {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    projectId: row.project_id,
    cycleId: row.cycle_id,
    labelIds: row.label_ids,
    repo: row.repo,
    branch: row.branch,
    prUrl: row.pr_url,
    prState: row.pr_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
