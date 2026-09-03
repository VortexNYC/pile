import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import {
  account,
  attachments,
  comments,
  cycles,
  issueHistory,
  issueRelations,
  issueSubscribers,
  labels,
  linearUsers,
  projects,
  repoBranches,
  repoIssues,
  session,
  states,
  templates,
  user,
  verification,
  webhookDeliveries,
  webhookSubscriptions,
  workspaces,
  workspaceMemberships,
  workspaceTokens,
} from "./schema.js";

const tables: Record<string, SQLiteTable> = {
  account,
  attachments,
  comments,
  cycles,
  issueHistory,
  issueRelations,
  issueSubscribers,
  labels,
  linearUsers,
  projects,
  repoBranches,
  repoIssues,
  session,
  states,
  templates,
  user,
  verification,
  webhookDeliveries,
  webhookSubscriptions,
  workspaces,
  workspaceMemberships,
  workspaceTokens,
};

export function createD1(d1: D1Database) {
  return drizzle(d1, { schema: tables });
}

export type D1Client = ReturnType<typeof createD1>;
