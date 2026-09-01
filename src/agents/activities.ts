export type AgentActivityType = "thought" | "response" | "error" | "elicitation";

export interface AgentActivity {
  sessionId: string;
  type: AgentActivityType;
  message: string;
  createdAt: string;
}
