import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../platform/env.js";
import type { WorkspaceToken } from "./middleware.js";
import type {
  IssueInput,
  WorkspaceDurableObjectStub,
} from "../workspace/types.js";
import { VortexError } from "../platform/errors.js";
import { getAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { createRepoBranch } from "../global/repo-branches.js";

const createIssueSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "done", "canceled"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  cycleId: z.string().optional(),
  labelIds: z.string().optional(),
}) satisfies z.ZodType<IssueInput>;

const updateIssueSchema = createIssueSchema.partial();

type Variables = {
  workspaceToken: WorkspaceToken;
};

type HonoContext = Context<{ Bindings: AppEnv; Variables: Variables }>;

function getWorkspaceId(c: HonoContext): string {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "workspaceId is required",
    });
  }
  return workspaceId;
}

function getIssueId(c: HonoContext): string {
  const id = c.req.param("id");
  if (!id) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "id is required",
    });
  }
  return id;
}

function getWorkspaceDO(
  env: AppEnv,
  workspaceId: string
): WorkspaceDurableObjectStub {
  const id = env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(id);
  return stub as unknown as WorkspaceDurableObjectStub;
}

const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();

app.get("/", async (c) => {
  const workspaceId = getWorkspaceId(c);
  const doStub = getWorkspaceDO(c.env, workspaceId);
  const issues = await doStub.listIssues();
  return c.json({ issues });
});

app.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = createIssueSchema.safeParse(body);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid issue input",
      hint: parsed.error.message,
    });
  }

  const workspaceId = getWorkspaceId(c);
  const doStub = getWorkspaceDO(c.env, workspaceId);
  const issue = await doStub.createIssue(parsed.data);
  return c.json(issue, 201);
});

app.get("/:id", async (c) => {
  const workspaceId = getWorkspaceId(c);
  const id = getIssueId(c);
  const doStub = getWorkspaceDO(c.env, workspaceId);
  const issue = await doStub.getIssue(id);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  return c.json(issue);
});

app.patch("/:id", async (c) => {
  const body = await c.req.json();
  const parsed = updateIssueSchema.safeParse(body);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid issue input",
      hint: parsed.error.message,
    });
  }

  const workspaceId = getWorkspaceId(c);
  const id = getIssueId(c);
  const doStub = getWorkspaceDO(c.env, workspaceId);
  const issue = await doStub.updateIssue(id, parsed.data);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  return c.json(issue);
});

app.post("/:id/dispatch", async (c) => {
  const body = await c.req.json();
  const agentId = typeof body?.agentId === "string" ? body.agentId : "devin";
  const model = typeof body?.model === "string" ? body.model : undefined;

  const workspaceId = getWorkspaceId(c);
  const id = getIssueId(c);
  const doStub = getWorkspaceDO(c.env, workspaceId);
  const issue = await doStub.getIssue(id);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }

  const provider = getAgentProvider(agentId, c.env);
  const session = await provider.dispatch(workspaceId, issue, model);

  if (issue.repo && issue.branch) {
    const db = createD1(c.env.D1);
    await createRepoBranch(db, workspaceId, issue.repo, issue.branch, issue.id);
  }

  return c.json(session, 201);
});

export { app as issueRoutes };
