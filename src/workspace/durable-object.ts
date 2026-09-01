import type { DurableObject, DurableObjectState } from "@cloudflare/workers-types";
import { z } from "zod";
import { execOne, execAll } from "./sql.js";
import type { IssueInput, Issue, IssueStatus, IssuePriority } from "./types.js";
import type { AppEnv } from "../platform/env.js";

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
  created_at: z.string(),
  updated_at: z.string(),
});

export class WorkspaceDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv;
  private readonly sql: import("@cloudflare/workers-types").SqlStorage;
  private readonly workspaceId: string;

  constructor(state: DurableObjectState, env: AppEnv) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.workspaceId = state.id.toString();
    this.initSchema();
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("WorkspaceDO");
  }

  private initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS issues (
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
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_issues_workspace_status
      ON issues (status, created_at DESC)
    `);
  }

  createIssue(input: IssueInput): Issue {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? "backlog";
    const priority = input.priority ?? "medium";

    const cursor = this.sql.exec(
      `INSERT INTO issues
        (id, workspace_id, title, description, status, priority, assignee_id, project_id, cycle_id, label_ids, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now,
      now
    );

    const rows = Array.from(cursor);
    const parsed = issueSchema.safeParse(rows[0]);
    if (!parsed.success) {
      throw new Error("Failed to create issue: invalid row shape");
    }

    return toIssue(parsed.data);
  }

  getIssue(id: string): Issue | undefined {
    const row = execOne(this.sql, issueSchema, "SELECT * FROM issues WHERE id = ?", id);
    return row ? toIssue(row) : undefined;
  }

  listIssues(): Issue[] {
    const rows = execAll(
      this.sql,
      issueSchema,
      "SELECT * FROM issues ORDER BY created_at DESC"
    );
    return rows.map(toIssue);
  }

  updateIssue(id: string, patch: Partial<IssueInput>): Issue | undefined {
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
    const query = `UPDATE issues SET ${sets.join(", ")}, updated_at = ? WHERE id = ? RETURNING *`;
    const row = execOne(this.sql, issueSchema, query, ...values);
    return row ? toIssue(row) : undefined;
  }
}

function toIssue(row: z.infer<typeof issueSchema>): Issue {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    assigneeId: row.assignee_id,
    projectId: row.project_id,
    cycleId: row.cycle_id,
    labelIds: row.label_ids,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
