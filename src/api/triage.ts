import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  TRIAGE_EVALUATION_OUTCOMES,
  TRIAGE_RECORD_TYPES,
  serializeTriageAction,
  serializeTriageConditions,
  triageActionSchema,
  triageConditionsSchema,
} from "../global/triage-rules.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const orgParam = z.object({ organizationId: z.string() });
const ruleIdParam = z.object({
  organizationId: z.string(),
  ruleId: z.string(),
});

const triageRuleSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  recordType: z.enum(TRIAGE_RECORD_TYPES),
  isActive: z.boolean(),
  sortOrder: z.number(),
  conditions: triageConditionsSchema,
  action: triageActionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createRuleBodySchema = z.object({
  name: z.string().min(1),
  recordType: z.enum(TRIAGE_RECORD_TYPES),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  conditions: triageConditionsSchema,
  action: triageActionSchema,
});

const updateRuleBodySchema = z.object({
  name: z.string().min(1).optional(),
  recordType: z.enum(TRIAGE_RECORD_TYPES).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  conditions: triageConditionsSchema.optional(),
  action: triageActionSchema.optional(),
});

const triageEvaluationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  ruleId: z.string().nullable(),
  ruleName: z.string().nullable(),
  outcome: z.enum(TRIAGE_EVALUATION_OUTCOMES),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

type TriageRuleRow = {
  id: string;
  organizationId: string;
  name: string;
  recordType: string;
  isActive: boolean;
  sortOrder: number;
  conditions: string;
  action: string;
  createdAt: string;
  updatedAt: string;
};

type TriageEvaluationRow = {
  id: string;
  organizationId: string;
  recordType: string;
  recordId: string;
  ruleId: string | null;
  ruleName: string | null;
  outcome: string;
  detail: string | null;
  createdAt: string;
};

function toApiRule(rule: TriageRuleRow) {
  return {
    id: rule.id,
    organizationId: rule.organizationId,
    name: rule.name,
    recordType: rule.recordType as (typeof TRIAGE_RECORD_TYPES)[number],
    isActive: rule.isActive,
    sortOrder: rule.sortOrder,
    conditions: triageConditionsSchema.parse(JSON.parse(rule.conditions)),
    action: triageActionSchema.parse(JSON.parse(rule.action)),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function toApiEvaluation(row: TriageEvaluationRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    recordType: row.recordType,
    recordId: row.recordId,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    outcome: row.outcome as (typeof TRIAGE_EVALUATION_OUTCOMES)[number],
    detail: row.detail
      ? (JSON.parse(row.detail) as Record<string, unknown>)
      : null,
    createdAt: row.createdAt,
  };
}

const listRulesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/triage/rules",
  tags: ["triage"],
  middleware: [rls("settings:view")],
  request: {
    params: orgParam,
    query: z.object({
      recordType: z.enum(TRIAGE_RECORD_TYPES).optional(),
    }),
  },
  responses: {
    200: {
      description: "Triage rules",
      content: {
        "application/json": {
          schema: z.object({ rules: z.array(triageRuleSchema) }),
        },
      },
    },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/triage/rules",
  tags: ["triage"],
  middleware: [rls("settings:create")],
  description:
    "Ordered auto-delegate rules evaluated on inbound records (lead, intake_item, customer, deal, issue, support_ticket). Rules run in sortOrder then createdAt order; the first match wins and the evaluation is logged to /triage/evaluations.",
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
          schema: z.object({ rule: triageRuleSchema }),
        },
      },
    },
  },
});

const getRuleRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/triage/rules/{ruleId}",
  tags: ["triage"],
  middleware: [rls("settings:view")],
  request: { params: ruleIdParam },
  responses: {
    200: {
      description: "Rule",
      content: {
        "application/json": {
          schema: z.object({ rule: triageRuleSchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/triage/rules/{ruleId}",
  tags: ["triage"],
  middleware: [rls("settings:edit")],
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
          schema: z.object({ rule: triageRuleSchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/triage/rules/{ruleId}",
  tags: ["triage"],
  middleware: [rls("settings:delete")],
  request: { params: ruleIdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found" },
  },
});

const listEvaluationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/triage/evaluations",
  tags: ["triage"],
  middleware: [rls("settings:view")],
  description:
    "The rule evaluation log — one row per inbound record evaluated while at least one active rule existed for its record type: which rule matched (ruleId null on no_match), the outcome, and what the action applied.",
  request: {
    params: orgParam,
    query: z.object({
      recordType: z.enum(TRIAGE_RECORD_TYPES).optional(),
      recordId: z.string().optional(),
      ruleId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "Evaluation log",
      content: {
        "application/json": {
          schema: z.object({
            evaluations: z.array(triageEvaluationSchema),
          }),
        },
      },
    },
  },
});

export function registerTriageRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRulesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { recordType } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const rules = await stub.listTriageRules({ recordType });
    return c.json({ rules: rules.map(toApiRule) });
  });

  app.openapi(createRuleRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const rule = await stub.createTriageRule(
      {
        name: body.name,
        recordType: body.recordType,
        isActive: body.isActive,
        sortOrder: body.sortOrder,
        conditions: serializeTriageConditions(body.conditions),
        action: serializeTriageAction(body.action),
      },
      { actorId: identity.id, actorType: identity.type }
    );
    return c.json({ rule: toApiRule(rule) }, 201);
  });

  app.openapi(getRuleRoute, async (c) => {
    const { organizationId, ruleId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const rule = await stub.getTriageRule(ruleId);
    if (!rule) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Triage rule not found",
      });
    }
    return c.json({ rule: toApiRule(rule) });
  });

  app.openapi(updateRuleRoute, async (c) => {
    const { organizationId, ruleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const rule = await stub.updateTriageRule(
      ruleId,
      {
        name: body.name,
        recordType: body.recordType,
        isActive: body.isActive,
        sortOrder: body.sortOrder,
        conditions: body.conditions
          ? serializeTriageConditions(body.conditions)
          : undefined,
        action: body.action ? serializeTriageAction(body.action) : undefined,
      },
      { actorId: identity.id, actorType: identity.type }
    );
    if (!rule) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Triage rule not found",
      });
    }
    return c.json({ rule: toApiRule(rule) });
  });

  app.openapi(deleteRuleRoute, async (c) => {
    const { organizationId, ruleId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const deleted = await stub.deleteTriageRule(ruleId, {
      actorId: identity.id,
      actorType: identity.type,
    });
    if (!deleted) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Triage rule not found",
      });
    }
    return c.body(null, 204);
  });

  app.openapi(listEvaluationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { recordType, recordId, ruleId, limit } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const evaluations = await stub.listTriageEvaluations({
      recordType,
      recordId,
      ruleId,
      limit,
    });
    return c.json({ evaluations: evaluations.map(toApiEvaluation) });
  });
}
