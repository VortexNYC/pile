import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { DEFAULT_AGENTS_MD } from "../global/agent-context.js";
import { createD1 } from "../global/db.js";
import { workspaceAgentContext } from "../global/schema.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const agentRuleSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
});

const agentSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  content: z.string(),
});

const agentContextSchema = z.object({
  organizationId: z.string(),
  agentsMd: z.string(),
  rules: z.array(agentRuleSchema),
  skills: z.array(agentSkillSchema),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
});

const putAgentContextBodySchema = z.object({
  agentsMd: z.string().optional(),
  rules: z.array(agentRuleSchema).optional(),
  skills: z.array(agentSkillSchema).optional(),
});

type AgentContextRow = typeof workspaceAgentContext.$inferSelect;

function rowToResponse(row: AgentContextRow | null, organizationId: string) {
  if (!row) {
    return {
      organizationId,
      agentsMd: DEFAULT_AGENTS_MD,
      rules: [] as z.infer<typeof agentRuleSchema>[],
      skills: [] as z.infer<typeof agentSkillSchema>[],
      updatedBy: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    organizationId: row.organizationId,
    agentsMd: row.agentsMd || DEFAULT_AGENTS_MD,
    rules: JSON.parse(row.rules) as z.infer<typeof agentRuleSchema>[],
    skills: JSON.parse(row.skills) as z.infer<typeof agentSkillSchema>[],
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

async function getContextRow(
  db: ReturnType<typeof createD1>,
  organizationId: string
) {
  const [row] = await db
    .select()
    .from(workspaceAgentContext)
    .where(eq(workspaceAgentContext.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

const getAgentContextRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent-context",
  tags: ["agent-context"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Workspace agent context: AGENTS.md content, always-on rules, and the skill catalog. Served to agents and harnesses as the workspace's source of truth.",
      content: {
        "application/json": { schema: agentContextSchema },
      },
    },
  },
});

const putAgentContextRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/agent-context",
  tags: ["agent-context"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: putAgentContextBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Agent context updated",
      content: {
        "application/json": { schema: agentContextSchema },
      },
    },
  },
});

const listAgentRulesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent-context/rules",
  tags: ["agent-context"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace always-on agent rules",
      content: {
        "application/json": {
          schema: z.object({ rules: z.array(agentRuleSchema) }),
        },
      },
    },
  },
});

const listAgentSkillsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent-context/skills",
  tags: ["agent-context"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace agent skill catalog",
      content: {
        "application/json": {
          schema: z.object({ skills: z.array(agentSkillSchema) }),
        },
      },
    },
  },
});

export function registerAgentContextRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(getAgentContextRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await getContextRow(db, organizationId);
    return c.json(agentContextSchema.parse(rowToResponse(row, organizationId)));
  });

  app.openapi(putAgentContextRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const identity = c.get("workspaceIdentity");
    const now = new Date().toISOString();

    const existing = await getContextRow(db, organizationId);
    const values = {
      organizationId,
      agentsMd: body.agentsMd ?? existing?.agentsMd ?? DEFAULT_AGENTS_MD,
      rules: JSON.stringify(body.rules ?? JSON.parse(existing?.rules ?? "[]")),
      skills: JSON.stringify(
        body.skills ?? JSON.parse(existing?.skills ?? "[]")
      ),
      updatedBy: identity?.id ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await db.insert(workspaceAgentContext).values(values).onConflictDoUpdate({
      target: workspaceAgentContext.organizationId,
      set: values,
    });

    const row = await getContextRow(db, organizationId);
    return c.json(agentContextSchema.parse(rowToResponse(row, organizationId)));
  });

  app.openapi(listAgentRulesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await getContextRow(db, organizationId);
    return c.json({ rules: rowToResponse(row, organizationId).rules });
  });

  app.openapi(listAgentSkillsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await getContextRow(db, organizationId);
    return c.json({ skills: rowToResponse(row, organizationId).skills });
  });
}
