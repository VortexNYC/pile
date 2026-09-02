import type { AgentSession } from "./provider.js";

export interface AgentSessionRecord extends AgentSession {
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}
