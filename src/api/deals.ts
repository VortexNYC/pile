import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { DealStage } from "../workspace/data/index.js";
import { getWorkspaceStub } from "./stub.js";

const stageEnum = z.enum([
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);

const dealSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  name: z.string(),
  stage: stageEnum,
  amountCents: z.number().nullable(),
  currency: z.string().nullable(),
  expectedCloseAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  contactIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createDealSchema = z.object({
  customerId: z.string(),
  name: z.string().min(1),
  stage: stageEnum.default("lead"),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  contactIds: z.array(z.string()).optional(),
});

const updateDealSchema = z.object({
  customerId: z.string().optional(),
  name: z.string().min(1).optional(),
  stage: stageEnum.optional(),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  contactIds: z.array(z.string()).optional(),
});

function notFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Not found",
  });
}

const orgParam = z.object({ organizationId: z.string() });
const dealIdParam = z.object({
  organizationId: z.string(),
  dealId: z.string(),
});

const listDealsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/deals",
  tags: ["deals"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: z.object({
      customerId: z.string().optional(),
      includeArchived: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Deal list",
      content: {
        "application/json": {
          schema: z.object({ deals: z.array(dealSchema) }),
        },
      },
    },
  },
});

const createDealRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/deals",
  tags: ["deals"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: createDealSchema } },
    },
  },
  responses: {
    201: {
      description: "Created deal",
      content: {
        "application/json": { schema: z.object({ deal: dealSchema }) },
      },
    },
  },
});

const getDealRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/deals/{dealId}",
  tags: ["deals"],
  middleware: [rls("read")],
  request: { params: dealIdParam },
  responses: {
    200: {
      description: "Deal detail",
      content: {
        "application/json": { schema: z.object({ deal: dealSchema }) },
      },
    },
  },
});

const updateDealRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/deals/{dealId}",
  tags: ["deals"],
  middleware: [rls("write")],
  request: {
    params: dealIdParam,
    body: {
      content: { "application/json": { schema: updateDealSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated deal",
      content: {
        "application/json": { schema: z.object({ deal: dealSchema }) },
      },
    },
  },
});

const deleteDealRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/deals/{dealId}",
  tags: ["deals"],
  middleware: [rls("write")],
  request: { params: dealIdParam },
  responses: {
    200: {
      description: "Deleted deal",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

export function registerDealRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listDealsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { customerId, includeArchived } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const all = await stub.listDeals({
      includeArchived: includeArchived === "true",
    });
    const deals = customerId
      ? all.filter((d) => d.customerId === customerId)
      : all;
    return c.json({ deals: [...deals] }, 200);
  });

  app.openapi(createDealRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deal = await stub.createDeal({
      customerId: body.customerId,
      name: body.name,
      stage: body.stage as DealStage,
      amountCents: body.amountCents ?? null,
      currency: body.currency ?? null,
      expectedCloseAt: body.expectedCloseAt ?? null,
      contactIds: body.contactIds,
    });
    return c.json({ deal }, 201);
  });

  app.openapi(getDealRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deal = await stub.getDeal(dealId);
    if (!deal) notFound();
    return c.json({ deal }, 200);
  });

  app.openapi(updateDealRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deal = await stub.updateDeal(dealId, {
      name: body.name,
      customerId: body.customerId,
      stage: body.stage as DealStage | undefined,
      amountCents: body.amountCents,
      currency: body.currency,
      expectedCloseAt: body.expectedCloseAt,
      archivedAt: body.archivedAt,
      contactIds: body.contactIds,
    });
    if (!deal) notFound();
    return c.json({ deal }, 200);
  });

  app.openapi(deleteDealRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.deleteDeal(dealId);
    if (!ok) notFound();
    return c.json({ ok }, 200);
  });
}
