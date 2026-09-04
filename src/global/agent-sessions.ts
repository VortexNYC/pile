import { and, desc, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { agentActivities, agentSessions } from "./schema.js";

export type AgentSession = InferSelectModel<typeof agentSessions>;
export type AgentActivity = InferSelectModel<typeof agentActivities>;

export type AgentSessionStatus = AgentSession["status"];
export type AgentActivityType = AgentActivity["type"];

export interface AgentSessionInput {
  workspaceId: string;
  issueId: string;
  agentId: string;
  provider: string;
  actorId: string;
  actorType: "user" | "agent";
  status?: AgentSessionStatus;
  result?: string | null;
  url?: string | null;
}

export interface AgentActivityInput {
  sessionId: string;
  actorId?: string;
  type: AgentActivityType;
  message: string;
  payload?: Record<string, unknown>;
}

export async function createAgentSession(
  db: D1Client,
  input: AgentSessionInput
): Promise<AgentSession> {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(agentSessions).values({
    id,
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    agentId: input.agentId,
    provider: input.provider,
    actorId: input.actorId,
    actorType: input.actorType,
    status: input.status ?? "created",
    result: input.result ?? null,
    url: input.url ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  const row = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create agent session");
  }
  return row;
}

export async function getAgentSession(db: D1Client, id: string) {
  return db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
}

export async function listAgentSessions(
  db: D1Client,
  workspaceId: string,
  options: { issueId?: string; limit?: number } = {}
) {
  const conditions = [eq(agentSessions.workspaceId, workspaceId)];
  if (options.issueId) {
    conditions.push(eq(agentSessions.issueId, options.issueId));
  }
  return db
    .select()
    .from(agentSessions)
    .where(and(...conditions))
    .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id))
    .limit(options.limit ?? 100)
    .all();
}

export async function updateAgentSession(
  db: D1Client,
  id: string,
  input: Partial<Pick<AgentSession, "status" | "result" | "url">>
) {
  const existing = await getAgentSession(db, id);
  if (!existing) return null;

  const set: Partial<AgentSession> = { updatedAt: new Date().toISOString() };
  if (input.status !== undefined) set.status = input.status;
  if (input.result !== undefined) set.result = input.result;
  if (input.url !== undefined) set.url = input.url;

  await db.update(agentSessions).set(set).where(eq(agentSessions.id, id));
  return getAgentSession(db, id);
}

export async function addAgentActivity(
  db: D1Client,
  input: AgentActivityInput
): Promise<AgentActivity> {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(agentActivities).values({
    id,
    sessionId: input.sessionId,
    actorId: input.actorId ?? null,
    type: input.type,
    message: input.message,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    createdAt: ts,
  });
  const row = await db
    .select()
    .from(agentActivities)
    .where(eq(agentActivities.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create agent activity");
  }
  return row;
}

export async function listAgentActivities(
  db: D1Client,
  sessionId: string,
  options: { limit?: number } = {}
) {
  return db
    .select()
    .from(agentActivities)
    .where(eq(agentActivities.sessionId, sessionId))
    .orderBy(agentActivities.createdAt)
    .limit(options.limit ?? 1000)
    .all();
}

export async function getAgentSessionWithActivities(db: D1Client, id: string) {
  const session = await getAgentSession(db, id);
  if (!session) return null;
  const activities = await listAgentActivities(db, id);
  return { ...session, activities };
}
