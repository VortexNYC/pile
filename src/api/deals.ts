import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { drainDomainEvents } from "../agents/pipeline-events.js";
import { createD1 } from "../global/db.js";
import { runTriageRules } from "../global/triage-rules.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { isAdminIdentity } from "../platform/permissions.js";
import { rls } from "../platform/rls.js";
import type { DealStage } from "../workspace/data/index.js";
import { getExecutionCtx } from "./execution-ctx.js";
import {
  decodeCursor,
  limitQueryParam,
  matchesSearchQuery,
  pageByCreatedCursor,
} from "./list-args.js";
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
  externalId: z.string().nullable(),
  stage: stageEnum,
  amountCents: z.number().nullable(),
  currency: z.string().nullable(),
  expectedCloseAt: z.string().nullable(),
  description: z.string().nullable(),
  closedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  nextStepText: z.string().nullable(),
  nextStepDueAt: z.string().nullable(),
  needsHuman: z.boolean().nullable(),
  needsHumanReason: z.string().nullable(),
  priorityScore: z.number().nullable(),
  contactIds: z.array(z.string()),
  // Name-keyed custom field values (definitions live under
  // /workspaces/{org}/fields with entityType="deal").
  customFields: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** PILE-653 — `?summary=1` list shape: the pipeline/picker fields only —
 *  description, contactIds, customFields and the hygiene blobs stay on the
 *  full row. */
const dealSummarySchema = dealSchema.pick({
  id: true,
  customerId: true,
  name: true,
  stage: true,
  amountCents: true,
  currency: true,
  expectedCloseAt: true,
  closedAt: true,
  archivedAt: true,
  nextStepDueAt: true,
  needsHuman: true,
  createdAt: true,
  updatedAt: true,
});

const createDealSchema = z.object({
  customerId: z.string(),
  name: z.string().min(1),
  externalId: z.string().min(1).max(255).optional(),
  stage: stageEnum.default("lead"),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  contactIds: z.array(z.string()).optional(),
  nextStepText: z.string().nullable().optional(),
  nextStepDueAt: z.string().nullable().optional(),
  needsHuman: z.boolean().nullable().optional(),
  needsHumanReason: z.string().nullable().optional(),
  priorityScore: z.number().nullable().optional(),
  // Field values keyed by field name — unknown names auto-create a text
  // field definition; null clears a value.
  customFields: z.record(z.string(), z.string().nullable()).optional(),
});

const updateDealSchema = z.object({
  customerId: z.string().optional(),
  name: z.string().min(1).optional(),
  externalId: z.string().min(1).max(255).nullable().optional(),
  stage: stageEnum.optional(),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  contactIds: z.array(z.string()).optional(),
  issueIds: z.array(z.string()).optional(),
  nextStepText: z.string().nullable().optional(),
  nextStepDueAt: z.string().nullable().optional(),
  needsHuman: z.boolean().nullable().optional(),
  needsHumanReason: z.string().nullable().optional(),
  priorityScore: z.number().nullable().optional(),
  customFields: z.record(z.string(), z.string().nullable()).optional(),
  // PILE-412 — admin-only stage-gate override for the stage transition:
  // proceed past open required sub-steps on linked parent issues, recording
  // the reason in audit + issue history. Non-admin callers get 403.
  stageGateOverride: z
    .object({ reason: z.string().min(1).max(2000) })
    .optional(),
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

export const DEAL_LIST_DEFAULT_LIMIT = 500;
export const DEAL_LIST_MAX_LIMIT = 1000;

const listDealsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/deals",
  tags: ["deals"],
  middleware: [rls("deal:view")],
  request: {
    params: orgParam,
    query: z.object({
      customerId: z.string().optional(),
      contactId: z.string().optional(),
      includeArchived: z.string().optional(),
      stage: stageEnum.optional(),
      dueBefore: z.string().optional().openapi({
        description:
          "Only deals whose nextStepDueAt is on/before this ISO timestamp",
      }),
      cold: z.string().optional().openapi({
        description:
          "cold=true → open deals with no nextStepText and no nextStepDueAt",
      }),
      needsHuman: z.string().optional(),
      // PILE-653 — bounded list contract, same shape as /issues:
      // (createdAt,id) keyset pages via cursor, nextCursor while pages fill.
      limit: limitQueryParam(
        DEAL_LIST_DEFAULT_LIMIT,
        DEAL_LIST_MAX_LIMIT
      ).openapi({
        description: `Page size, default ${DEAL_LIST_DEFAULT_LIMIT}, max ${DEAL_LIST_MAX_LIMIT}`,
      }),
      cursor: z.string().optional().openapi({
        description: "Opaque page cursor from a previous nextCursor",
      }),
      q: z.string().optional().openapi({
        description: "Case-insensitive substring match on deal name",
      }),
      summary: z.string().optional().openapi({
        description:
          "summary=1 → pipeline/picker rows without description, contactIds, or customFields",
      }),
    }),
  },
  responses: {
    200: {
      description: "Deal list",
      content: {
        "application/json": {
          schema: z.object({
            deals: z.array(z.union([dealSchema, dealSummarySchema])),
            nextCursor: z.string().optional(),
          }),
        },
      },
    },
  },
});

const createDealRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/deals",
  tags: ["deals"],
  middleware: [rls("deal:create")],
  description:
    "externalId is a hard dedupe key (same contract as issues' externalRef): when a deal with the same externalId exists the call returns that deal with 200 instead of creating a duplicate. Pass dedupe=block to get 409 with the existing record in details.deal instead — the hard guarantee importers need.",
  request: {
    params: orgParam,
    query: z.object({
      dedupe: z.enum(["warn", "block"]).optional(),
    }),
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
    200: {
      description: "Existing deal with the same externalId (idempotent create)",
      content: {
        "application/json": { schema: z.object({ deal: dealSchema }) },
      },
    },
    409: {
      description: "dedupe=block and externalId is already used",
    },
  },
});

const getDealRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/deals/{dealId}",
  tags: ["deals"],
  middleware: [rls("deal:view")],
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
  middleware: [rls("deal:edit")],
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
  middleware: [rls("deal:delete")],
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

/** PILE-653 — `q` matches the deal name; pickers search by what renders. */
export function dealMatchesQuery(
  row: { name?: string | null },
  q: string
): boolean {
  return matchesSearchQuery([row.name], q);
}

/** The `summary=1` projection — pipeline/picker fields, no blobs. */
export function toDealSummary(row: {
  id: string;
  customerId: string;
  name: string;
  stage: DealStage;
  amountCents: number | null;
  currency: string | null;
  expectedCloseAt: string | null;
  closedAt: string | null;
  archivedAt: string | null;
  nextStepDueAt: string | null;
  needsHuman: boolean | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    stage: row.stage,
    amountCents: row.amountCents,
    currency: row.currency,
    expectedCloseAt: row.expectedCloseAt,
    closedAt: row.closedAt,
    archivedAt: row.archivedAt,
    nextStepDueAt: row.nextStepDueAt,
    needsHuman: row.needsHuman,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerDealRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listDealsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const {
      customerId,
      contactId,
      includeArchived,
      stage,
      dueBefore,
      cold,
      needsHuman,
      limit,
      cursor,
      q,
      summary,
    } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const all = await stub.listDeals({
      includeArchived: includeArchived === "true",
      stage,
      dueBefore,
      cold: cold === "true",
      needsHuman: needsHuman === "true",
    });
    const scoped = all.filter((d) => {
      if (customerId && d.customerId !== customerId) return false;
      // contactId was declared on the route but never applied — the
      // contact page listed every deal in the workspace.
      if (contactId && !d.contactIds.includes(contactId)) return false;
      if (q && !dealMatchesQuery(d, q)) return false;
      return true;
    });
    const { page, nextCursor } = pageByCreatedCursor(scoped, {
      limit,
      cursor: cursor ? decodeCursor(cursor) : undefined,
    });
    const deals =
      summary === "1" || summary === "true" ? page.map(toDealSummary) : page;
    return c.json({ deals, nextCursor }, 200);
  });

  app.openapi(createDealRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { dedupe } = c.req.valid("query");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (body.externalId) {
      const existing = await stub.getDealByExternalId(body.externalId);
      if (existing) {
        if (dedupe === "block") {
          throw new VortexError({
            code: "CONFLICT",
            status: 409,
            message: "externalId already used",
            hint: `Update deal ${existing.id} instead, or retry without dedupe=block`,
            details: { deal: existing },
          });
        }
        return c.json({ deal: existing }, 200);
      }
    }
    const deal = await stub.createDeal({
      customerId: body.customerId,
      name: body.name,
      externalId: body.externalId ?? null,
      stage: body.stage as DealStage,
      amountCents: body.amountCents ?? null,
      currency: body.currency ?? null,
      expectedCloseAt: body.expectedCloseAt ?? null,
      description: body.description ?? null,
      contactIds: body.contactIds,
      nextStepText: body.nextStepText ?? null,
      nextStepDueAt: body.nextStepDueAt ?? null,
      needsHuman: body.needsHuman ?? null,
      needsHumanReason: body.needsHumanReason ?? null,
      priorityScore: body.priorityScore ?? null,
      customFields: body.customFields,
    });
    // PILE-427 — a created deal is an inbound record for triage rules.
    // The externalId idempotent path returns early above, so retries
    // never double-evaluate. Re-read after a match so the response
    // reflects what the rule stamped.
    const triage = await runTriageRules(
      c.env,
      createD1(c.env.D1),
      organizationId,
      {
        recordType: "deal",
        recordId: deal.id,
        title: `Deal: ${deal.name}`,
        text: [deal.name, deal.description].filter(Boolean).join("\n"),
        status: deal.stage,
        dealId: deal.id,
        customerId: deal.customerId,
        fields: {
          stage: deal.stage,
          amountCents: deal.amountCents ?? null,
          currency: deal.currency ?? null,
          customerId: deal.customerId,
          externalId: deal.externalId ?? null,
          expectedCloseAt: deal.expectedCloseAt ?? null,
        },
      }
    );
    const responseDeal =
      triage?.outcome === "matched"
        ? ((await stub.getDeal(deal.id)) ?? deal)
        : deal;
    return c.json({ deal: responseDeal }, 201);
  });

  app.openapi(getDealRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deal = await stub.getDeal(dealId);
    if (!deal) notFound();
    getExecutionCtx(c)?.waitUntil(
      drainDomainEvents(c.env, stub, organizationId, getExecutionCtx(c))
    );
    return c.json({ deal }, 200);
  });

  app.openapi(updateDealRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    if (body.stageGateOverride !== undefined && !isAdminIdentity(identity)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "stageGateOverride requires admin",
      });
    }
    const stub = getWorkspaceStub(c.env, organizationId);
    const deal = await stub.updateDeal(
      dealId,
      {
        name: body.name,
        customerId: body.customerId,
        externalId: body.externalId,
        stage: body.stage as DealStage | undefined,
        amountCents: body.amountCents,
        currency: body.currency,
        expectedCloseAt: body.expectedCloseAt,
        archivedAt: body.archivedAt,
        contactIds: body.contactIds,
        nextStepText: body.nextStepText,
        nextStepDueAt: body.nextStepDueAt,
        needsHuman: body.needsHuman,
        needsHumanReason: body.needsHumanReason,
        priorityScore: body.priorityScore,
        customFields: body.customFields,
        stageGateOverride: body.stageGateOverride,
      },
      identity.id
    );
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

// deal ↔ issue links — the work-graph bridge

const linkSchema = z.object({ issueId: z.string() });
const dealIssueParam = z.object({
  organizationId: z.string(),
  dealId: z.string(),
  issueId: z.string().optional(),
});

const listDealIssuesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/deals/{dealId}/issues",
  tags: ["deals"],
  middleware: [rls("deal:view")],
  request: { params: dealIdParam },
  responses: {
    200: {
      description: "Issue ids linked to this deal",
      content: {
        "application/json": {
          schema: z.object({ issueIds: z.array(z.string()) }),
        },
      },
    },
  },
});

const linkIssueRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/deals/{dealId}/issues",
  tags: ["deals"],
  middleware: [rls("deal:edit")],
  request: {
    params: dealIdParam,
    body: { content: { "application/json": { schema: linkSchema } } },
  },
  responses: {
    200: {
      description: "Linked",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

const unlinkIssueRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/deals/{dealId}/issues/{issueId}",
  tags: ["deals"],
  middleware: [rls("deal:delete")],
  request: { params: dealIssueParam },
  responses: {
    200: {
      description: "Unlinked",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

export function registerDealIssueLinkRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listDealIssuesRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ issueIds: await stub.listDealIssueIds(dealId) }, 200);
  });

  app.openapi(linkIssueRoute, async (c) => {
    const { organizationId, dealId } = c.req.valid("param");
    const { issueId } = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.linkDealIssue(dealId, issueId);
    return c.json({ ok: true }, 200);
  });

  app.openapi(unlinkIssueRoute, async (c) => {
    const { organizationId, dealId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.unlinkDealIssue(dealId, issueId!);
    return c.json({ ok: true }, 200);
  });
}

const issueDealsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/deals",
  tags: ["deals"],
  middleware: [rls("issue:view")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Deals linked to this issue",
      content: {
        "application/json": {
          schema: z.object({ deals: z.array(dealSchema) }),
        },
      },
    },
  },
});

export function registerIssueDealRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(issueDealsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deals = await stub.listDealsForIssue(issueId);
    return c.json({ deals: [...deals] }, 200);
  });
}
