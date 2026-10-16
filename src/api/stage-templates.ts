import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { StageEntityType } from "../types/workspace.js";
import { getWorkspaceStub } from "./stub.js";

// PILE-411 — stage templates (Salesforce Flow Orchestration style). A
// template is one sub-step definition for a (entityType, status) stage:
// when an issue enters the status (or a deal/customer record transitions
// stage/status), the workspace materializes one sub-issue per applicable
// definition under the record's parent issue(s). Re-entering a stage never
// duplicates a step — (parent, stepKey) is the idempotency key.

const entityTypeSchema = z.enum(["issue", "deal", "customer"]);

const stepConditionSchema = z
  .object({
    field: z.string().min(1),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .describe(
    'Optional gate — `{field}` creates the step only when the record\'s field (column or custom field) is truthy; `{field, equals}` compares for equality. Field names normalize: "Hardware needed" == "hardware_needed".'
  );

const stageTemplateSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    entityType: entityTypeSchema,
    /** Slug-normalized stage key the transition matches ("prospect"). */
    status: z.string(),
    stepKey: z.string(),
    title: z.string(),
    required: z.boolean(),
    ownerAgent: z.string().nullable(),
    condition: stepConditionSchema.nullable(),
    position: z.number().int(),
    teamId: z.string().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("StageTemplate");

const createStageTemplateSchema = z
  .object({
    entityType: entityTypeSchema.optional(),
    status: z.string().min(1),
    stepKey: z.string().min(1),
    title: z.string().min(1),
    required: z.boolean().optional(),
    ownerAgent: z.string().nullable().optional(),
    condition: stepConditionSchema.nullable().optional(),
    position: z.number().int().optional(),
    teamId: z.string().nullable().optional(),
  })
  .strict();

const updateStageTemplateSchema = z
  .object({
    entityType: entityTypeSchema.optional(),
    status: z.string().min(1).optional(),
    stepKey: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    required: z.boolean().optional(),
    ownerAgent: z.string().nullable().optional(),
    condition: stepConditionSchema.nullable().optional(),
    position: z.number().int().optional(),
    teamId: z.string().nullable().optional(),
  })
  .strict();

function parseCondition(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toTemplateResponse(row: {
  id: string;
  organizationId: string;
  entityType: StageEntityType;
  status: string;
  stepKey: string;
  title: string;
  required: boolean;
  ownerAgent: string | null;
  condition: string | null;
  position: number;
  teamId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return { ...row, condition: parseCondition(row.condition) };
}

function notFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Stage template not found",
  });
}

const orgParam = z.object({ organizationId: z.string() });
const templateIdParam = z.object({
  organizationId: z.string(),
  id: z.string(),
});

const listStageTemplatesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/stage-templates",
  tags: ["stage-templates"],
  middleware: [rls("settings:view")],
  request: {
    params: orgParam,
    query: z.object({
      entityType: entityTypeSchema.optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Stage template list",
      content: {
        "application/json": {
          schema: z.object({
            templates: z.array(stageTemplateSchema),
          }),
        },
      },
    },
  },
});

const createStageTemplateRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/stage-templates",
  tags: ["stage-templates"],
  middleware: [rls("settings:create")],
  description:
    "Create a sub-step definition for a (entityType, status) stage. status and stepKey normalize to slug keys. entityType picks the transition that fires it: issue.status, deal.stage, or the customer's status name.",
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: createStageTemplateSchema } },
    },
  },
  responses: {
    201: {
      description: "Stage template created",
      content: {
        "application/json": {
          schema: z.object({ template: stageTemplateSchema }),
        },
      },
    },
  },
});

const getStageTemplateRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/stage-templates/{id}",
  tags: ["stage-templates"],
  middleware: [rls("settings:view")],
  request: { params: templateIdParam },
  responses: {
    200: {
      description: "Stage template",
      content: {
        "application/json": {
          schema: z.object({ template: stageTemplateSchema }),
        },
      },
    },
    404: { description: "Stage template not found" },
  },
});

const updateStageTemplateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/stage-templates/{id}",
  tags: ["stage-templates"],
  middleware: [rls("settings:edit")],
  request: {
    params: templateIdParam,
    body: {
      content: { "application/json": { schema: updateStageTemplateSchema } },
    },
  },
  responses: {
    200: {
      description: "Stage template updated",
      content: {
        "application/json": {
          schema: z.object({ template: stageTemplateSchema }),
        },
      },
    },
    404: { description: "Stage template not found" },
  },
});

const deleteStageTemplateRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/stage-templates/{id}",
  tags: ["stage-templates"],
  middleware: [rls("settings:delete")],
  request: { params: templateIdParam },
  responses: {
    200: {
      description: "Stage template deleted",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "Stage template not found" },
  },
});

const seedStageTemplatesRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/stage-templates/seed",
  tags: ["stage-templates"],
  middleware: [rls("settings:create")],
  description:
    "Install the default sales-led merchant pipeline stages (Prospect → Onboarding & go-live) as stage templates. Idempotent — existing (entityType, status, stepKey) rows are skipped so operator edits survive a re-seed; deleted rows are re-created.",
  request: { params: orgParam },
  responses: {
    200: {
      description: "Seeded stage templates",
      content: {
        "application/json": {
          schema: z.object({
            templates: z.array(stageTemplateSchema),
            skipped: z.number().int(),
          }),
        },
      },
    },
  },
});

export function registerStageTemplateRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listStageTemplatesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { entityType, status } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const templates = await stub.listStageTemplates({
      ...(entityType ? { entityType } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    return c.json({ templates: templates.map(toTemplateResponse) }, 200);
  });

  app.openapi(createStageTemplateRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const template = await stub.createStageTemplate(body, {
      actorId: identity.id,
      actorType: identity.type,
    });
    return c.json({ template: toTemplateResponse(template) }, 201);
  });

  app.openapi(getStageTemplateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const template = await stub.getStageTemplate(id);
    if (!template) notFound();
    return c.json({ template: toTemplateResponse(template) }, 200);
  });

  app.openapi(updateStageTemplateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const template = await stub.updateStageTemplate(id, body, {
      actorId: identity.id,
      actorType: identity.type,
    });
    if (!template) notFound();
    return c.json({ template: toTemplateResponse(template) }, 200);
  });

  app.openapi(deleteStageTemplateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const ok = await stub.deleteStageTemplate(id, {
      actorId: identity.id,
      actorType: identity.type,
    });
    if (!ok) notFound();
    return c.json({ ok: true }, 200);
  });

  app.openapi(seedStageTemplatesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const result = await stub.seedStageTemplates({
      actorId: identity.id,
      actorType: identity.type,
    });
    return c.json(
      {
        templates: result.created.map(toTemplateResponse),
        skipped: result.skipped,
      },
      200
    );
  });
}
