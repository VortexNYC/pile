import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createEscalationRule,
  deleteEscalationRule,
  escalationActionSchema,
  escalationConditionsSchema,
  getEscalationRuleById,
  listEscalationRules,
  updateEscalationRule,
  type SupportEscalationRule,
} from "../global/support-escalation.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const orgParam = z.object({ organizationId: z.string() });
const ruleIdParam = z.object({
  organizationId: z.string(),
  ruleId: z.string(),
});

const escalationRuleSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  conditions: escalationConditionsSchema,
  action: escalationActionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createRuleBodySchema = z.object({
  name: z.string().min(1),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  conditions: escalationConditionsSchema,
  action: escalationActionSchema,
});

const updateRuleBodySchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  conditions: escalationConditionsSchema.optional(),
  action: escalationActionSchema.optional(),
});

function toApiRule(rule: SupportEscalationRule) {
  return {
    id: rule.id,
    organizationId: rule.organizationId,
    name: rule.name,
    isActive: rule.isActive,
    sortOrder: rule.sortOrder,
    conditions: JSON.parse(rule.conditions),
    action: JSON.parse(rule.action),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

const listRulesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/escalation-rules",
  tags: ["support-escalation"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Escalation rules",
      content: {
        "application/json": {
          schema: z.object({ rules: z.array(escalationRuleSchema) }),
        },
      },
    },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/escalation-rules",
  tags: ["support-escalation"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: createRuleBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Rule created",
      content: {
        "application/json": {
          schema: z.object({ rule: escalationRuleSchema }),
        },
      },
    },
  },
});

const getRuleRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/escalation-rules/{ruleId}",
  tags: ["support-escalation"],
  middleware: [rls("read")],
  request: { params: ruleIdParam },
  responses: {
    200: {
      description: "Rule",
      content: {
        "application/json": {
          schema: z.object({ rule: escalationRuleSchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/support/escalation-rules/{ruleId}",
  tags: ["support-escalation"],
  middleware: [rls("write")],
  request: {
    params: ruleIdParam,
    body: {
      content: { "application/json": { schema: updateRuleBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Rule updated",
      content: {
        "application/json": {
          schema: z.object({ rule: escalationRuleSchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/escalation-rules/{ruleId}",
  tags: ["support-escalation"],
  middleware: [rls("write")],
  request: { params: ruleIdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found" },
  },
});

export function registerSupportEscalationRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRulesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rules = await listEscalationRules(db, organizationId);
    return c.json({ rules: rules.map(toApiRule) });
  });

  app.openapi(createRuleRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const rule = await createEscalationRule(db, {
      organizationId,
      name: body.name,
      isActive: body.isActive,
      sortOrder: body.sortOrder,
      conditions: body.conditions,
      action: body.action,
    });
    return c.json({ rule: toApiRule(rule) }, 201);
  });

  app.openapi(getRuleRoute, async (c) => {
    const { organizationId, ruleId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rule = await getEscalationRuleById(db, organizationId, ruleId);
    if (!rule) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Escalation rule not found",
      });
    }
    return c.json({ rule: toApiRule(rule) });
  });

  app.openapi(updateRuleRoute, async (c) => {
    const { organizationId, ruleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const rule = await updateEscalationRule(db, organizationId, ruleId, body);
    if (!rule) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Escalation rule not found",
      });
    }
    return c.json({ rule: toApiRule(rule) });
  });

  app.openapi(deleteRuleRoute, async (c) => {
    const { organizationId, ruleId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const deleted = await deleteEscalationRule(db, organizationId, ruleId);
    if (!deleted) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Escalation rule not found",
      });
    }
    return c.body(null, 204);
  });
}
