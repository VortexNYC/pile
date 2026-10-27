import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import {
  type NonPosSmbPresetId,
  PRESET_NON_POS_SMB_SOURCES,
  pullSource,
} from "../agents/collectors.js";
import { drainDomainEvents } from "../agents/pipeline-events.js";
import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { isAdminIdentity } from "../platform/permissions.js";
import { captureProductEvent } from "../platform/posthog.js";
import { rls } from "../platform/rls.js";
import {
  type AudienceCandidateMerchant,
  type AudienceFilterGroup,
  buildRepMorningBrief,
  queryDynamicAudience,
  runMerchantLeadPlay,
} from "../workspace/lead-play-engine.js";
import {
  applyInboundReplyOutcome,
  classifyInboundReply,
  createStatementReceivedChecklist,
} from "../workspace/reply-funnel-engine.js";
import type { workspaceEntityAttachments } from "../workspace/schema.js";
import {
  evaluateSendGate,
  type EmailVerificationStatus,
  type TouchChannel,
} from "../workspace/send-gate.js";
import {
  computeSmbMatchKey,
  DEFAULT_ICP_RULES,
  DEFAULT_SIGNAL_RULES,
  detectPosTechnographics,
  type MerchantSignal,
  parseCustomerSignalFacts,
  planDetectiveWaterfall,
  rankMerchantSignals,
} from "../workspace/signals-engine.js";
import { CUSTOMER_TOUCH_OUTCOMES } from "../workspace/touch-outcomes.js";
import { getExecutionCtx } from "./execution-ctx.js";
import {
  hiddenIssueIdsForIdentity,
  resolveVisibleIssueRef,
} from "./issue-access.js";
import {
  decodeCursor,
  limitQueryParam,
  matchesSearchQuery,
  pageByCreatedCursor,
} from "./list-args.js";
import { getWorkspaceStub } from "./stub.js";

/** PILE-653 — `?summary=1` list shape: the picker/badge fields only. The
 *  heavy columns (notes, customFields, signal evidence) stay on the full
 *  row so dropdowns stop paying for them. */
const customerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  statusId: z.string().nullable(),
  ownerId: z.string().nullable(),
  nextStepText: z.string().nullable(),
  nextStepDueAt: z.string().nullable(),
  needsHuman: z.boolean().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const customerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  bookingUrl: z.string().nullable(),
  notes: z.string().nullable(),
  logoUrl: z.string().nullable(),
  externalId: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  vertical: z.string().nullable(),
  neighborhood: z.string().nullable(),
  source: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  sourceAgentSlug: z.string().nullable(),
  readiness: z.string().nullable(),
  nextAction: z.string().nullable(),
  fit: z.string().nullable(),
  fitScore: z.number().nullable(),
  fitStatus: z.string().nullable(),
  processor: z.string().nullable(),
  evidenceUri: z.string().nullable(),
  tierId: z.string().nullable(),
  statusId: z.string().nullable(),
  ownerId: z.string().nullable(),
  nextStepText: z.string().nullable(),
  nextStepDueAt: z.string().nullable(),
  needsHuman: z.boolean().nullable(),
  needsHumanReason: z.string().nullable(),
  priorityScore: z.number().nullable(),
  // Name-keyed custom field values (definitions live under
  // /workspaces/{org}/fields with entityType="customer").
  customFields: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCustomerSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  // Canonical merchant host — stored normalized (scheme/www./path stripped).
  domain: z.string().optional(),
  bookingUrl: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  logoUrl: z.string().optional(),
  externalId: z.string().min(1).max(255).optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  vertical: z.string().optional(),
  neighborhood: z.string().optional(),
  source: z.string().optional(),
  readiness: z.string().optional(),
  nextAction: z.string().optional(),
  fit: z.string().optional(),
  fitScore: z.number().optional(),
  fitStatus: z.string().optional(),
  processor: z.string().optional(),
  evidenceUri: z.string().optional(),
  tierId: z.string().optional(),
  statusId: z.string().optional(),
  ownerId: z.string().optional(),
  nextStepText: z.string().nullable().optional(),
  nextStepDueAt: z.string().nullable().optional(),
  needsHuman: z.boolean().nullable().optional(),
  needsHumanReason: z.string().nullable().optional(),
  priorityScore: z.number().nullable().optional(),
  // Field values keyed by field name — unknown names auto-create a text
  // field definition; null clears a value.
  customFields: z.record(z.string(), z.string().nullable()).optional(),
});

const updateCustomerSchema = createCustomerSchema.partial().extend({
  url: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  // Nullable on PATCH so the stage control can clear a row back to "no
  // stage"; create keeps a concrete id.
  statusId: z.string().nullable().optional(),
  // PILE-412 — admin-only stage-gate override for the status transition:
  // proceed past open required sub-steps on linked deal issues, recording
  // the reason in audit + issue history. Non-admin callers get 403.
  stageGateOverride: z
    .object({ reason: z.string().min(1).max(2000) })
    .optional(),
});

const tierSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  key: z.string().nullable(),
  type: z.string(),
  color: z.string().nullable(),
  position: z.number(),
  createdAt: z.string(),
});

const tierBodySchema = z.object({
  name: z.string().min(1),
  // PILE-438 — explicit immutable key override; defaults to a slug of the
  // name at create and can never be edited afterward.
  key: z.string().min(1).optional(),
  // "active" | "terminal" — Passed/Lost end the pipeline.
  type: z.enum(["active", "terminal"]).optional(),
  color: z.string().optional(),
  position: z.number().optional(),
});

const needSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  issueId: z.string().nullable(),
  projectId: z.string().nullable(),
  priority: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

const needBodySchema = z.object({
  customerId: z.string().min(1),
  issueId: z.string().optional(),
  projectId: z.string().optional(),
  priority: z.string().optional(),
  note: z.string().optional(),
});

const customerAttachmentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  r2Key: z.string(),
  url: z.string(),
  bookingUrl: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
});

const uploadCustomerAttachmentSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.string().optional(),
  contentBase64: z.string().min(1),
});

const importDealSchema = z.object({
  name: z.string().optional(),
  stage: z
    .enum(["lead", "qualified", "proposal", "negotiation", "won", "lost"])
    .optional(),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  expectedCloseAt: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  priorityScore: z.number().nullable().optional(),
});

const importRowSchema = z.object({
  // Google Places corridor pulls dedupe on place_id → externalId
  // "gplace:<place_id>" (the PILE-402 dedupe contract).
  placeId: z.string().min(1).optional(),
  externalId: z.string().min(1).max(255).optional(),
  name: z.string().min(1),
  url: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Pipeline column name — resolved or created. statusId wins when both
  // are provided.
  status: z.string().min(1).optional(),
  statusId: z.string().optional(),
  tierId: z.string().optional(),
  ownerId: z.string().optional(),
  nextStepText: z.string().nullable().optional(),
  nextStepDueAt: z.string().nullable().optional(),
  needsHuman: z.boolean().nullable().optional(),
  needsHumanReason: z.string().nullable().optional(),
  priorityScore: z.number().nullable().optional(),
  customFields: z.record(z.string(), z.string().nullable()).optional(),
  deal: importDealSchema.optional(),
});

const importCustomersBodySchema = z.object({
  source: z.string().optional(),
  corridor: z.string().optional(),
  rows: z.array(importRowSchema).min(1).max(1000),
});

const importRowReceiptSchema = z.object({
  index: z.number().int(),
  externalId: z.string().nullable(),
  outcome: z.enum(["created", "existing", "failed"]),
  customerId: z.string().optional(),
  dealId: z.string().optional(),
  error: z.string().optional(),
});

const importReceiptSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  source: z.string().nullable(),
  corridor: z.string().nullable(),
  total: z.number().int(),
  created: z.number().int(),
  existing: z.number().int(),
  failed: z.number().int(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
});

const importReceiptSchema = importReceiptSummarySchema.extend({
  rows: z.array(importRowReceiptSchema),
});

const intakeAttachmentSchema = z.object({
  key: z.string().nullable(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

const intakeItemSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  source: z.string(),
  inboxId: z.string().nullable(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  toAddress: z.string(),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  externalId: z.string(),
  messageId: z.string().nullable(),
  attachments: z.array(intakeAttachmentSchema).nullable(),
  receivedAt: z.string(),
  createdAt: z.string(),
});

function notFound(message = "Not found"): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message });
}

const orgParam = z.object({ organizationId: z.string() });
const orgIdParam = z.object({
  organizationId: z.string(),
  id: z.string(),
});

// Shlomo Kabareti's user id — default owner for auto-created
// Bookkeeper / CPA Partner records in the main Vortex workspace.
const VORTEX_MAIN_PARTNER_OWNER_ID = "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE";

export const CUSTOMER_LIST_DEFAULT_LIMIT = 500;
export const CUSTOMER_LIST_MAX_LIMIT = 1000;

const listCustomersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: {
    params: orgParam,
    query: z.object({
      dueBefore: z.string().optional().openapi({
        description:
          "Only customers whose nextStepDueAt is on/before this ISO timestamp",
      }),
      cold: z.string().optional().openapi({
        description:
          "cold=true → customers with no nextStepText and no nextStepDueAt",
      }),
      needsHuman: z.string().optional(),
      externalId: z.string().optional().openapi({
        description: "Exact-match lookup by externalId",
      }),
      domain: z.string().optional().openapi({
        description:
          "Exact-match lookup by canonical domain (input is normalized first)",
      }),
      // PILE-653 — bounded list contract, same shape as /issues:
      // (createdAt,id) keyset pages via cursor, nextCursor while pages fill.
      limit: limitQueryParam(
        CUSTOMER_LIST_DEFAULT_LIMIT,
        CUSTOMER_LIST_MAX_LIMIT
      ).openapi({
        description: `Page size, default ${CUSTOMER_LIST_DEFAULT_LIMIT}, max ${CUSTOMER_LIST_MAX_LIMIT}`,
      }),
      cursor: z.string().optional().openapi({
        description: "Opaque page cursor from a previous nextCursor",
      }),
      q: z.string().optional().openapi({
        description: "Case-insensitive substring match on name, domain, or url",
      }),
      summary: z.string().optional().openapi({
        description:
          "summary=1 → light picker rows (id, name, domain, statusId, ownerId, nextStepText, nextStepDueAt, needsHuman, timestamps)",
      }),
    }),
  },
  responses: {
    200: {
      description: "Customer list",
      content: {
        "application/json": {
          schema: z.object({
            customers: z.array(
              z.union([customerSchema, customerSummarySchema])
            ),
            nextCursor: z.string().optional(),
          }),
        },
      },
    },
  },
});

const createCustomerRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customers",
  tags: ["customers"],
  middleware: [rls("customer:create")],
  description:
    "externalId is a hard dedupe key (same contract as issues' externalRef): when a customer with the same externalId exists the call returns that customer with 200 instead of creating a duplicate. Pass dedupe=block to get 409 with the existing record in details.customer instead — the hard guarantee importers need.",
  request: {
    params: orgParam,
    query: z.object({
      dedupe: z.enum(["warn", "block"]).optional(),
    }),
    body: {
      content: { "application/json": { schema: createCustomerSchema } },
    },
  },
  responses: {
    201: {
      description: "Customer created",
      content: { "application/json": { schema: customerSchema } },
    },
    200: {
      description:
        "Existing customer with the same externalId (idempotent create)",
      content: { "application/json": { schema: customerSchema } },
    },
    409: {
      description: "dedupe=block and externalId is already used",
    },
  },
});

const importCustomersRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customers/import",
  tags: ["customers"],
  middleware: [rls("customer:create")],
  description:
    'Bulk merchant import — Scout\'s write path. Each row becomes a customer deduped on externalId (placeId maps to "gplace:<place_id>"); re-runs return existing records and fill empty slots rather than duplicating. Optionally creates an initial deal per row (stage defaults to "lead"). Every row lands a receipt (created/existing/failed + why) and the batch itself is persisted as an import receipt readable via GET /customer-imports/{id}.',
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: importCustomersBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Import receipt — per-row outcomes included",
      content: { "application/json": { schema: importReceiptSchema } },
    },
  },
});

const listImportReceiptsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-imports",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Import receipt history (summaries — no row details)",
      content: {
        "application/json": {
          schema: z.object({
            imports: z.array(importReceiptSummarySchema),
          }),
        },
      },
    },
  },
});

const getImportReceiptRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-imports/{id}",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Import receipt with per-row outcomes",
      content: { "application/json": { schema: importReceiptSchema } },
    },
    404: { description: "Import receipt not found" },
  },
});

const getCustomerRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers/{id}",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Customer",
      content: { "application/json": { schema: customerSchema } },
    },
    404: { description: "Customer not found" },
  },
});

const updateCustomerRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customers/{id}",
  tags: ["customers"],
  middleware: [rls("customer:edit")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: updateCustomerSchema } },
    },
  },
  responses: {
    200: {
      description: "Customer updated",
      content: { "application/json": { schema: customerSchema } },
    },
    404: { description: "Customer not found" },
  },
});

const logInteractionBodySchema = z.object({
  outcome: z.enum(CUSTOMER_TOUCH_OUTCOMES).openapi({
    description:
      "Canonical knock outcome — drives the next-step defaults and stage auto-advance",
  }),
  note: z.string().max(4000).optional(),
  nextStepText: z.string().nullable().optional(),
  nextStepDueAt: z.string().nullable().optional(),
});

const customerInteractionSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  outcome: z.enum(CUSTOMER_TOUCH_OUTCOMES),
  note: z.string().nullable(),
  createdAt: z.string(),
});

const logCustomerInteractionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customers/{id}/interactions",
  tags: ["customers"],
  middleware: [rls("customer:edit")],
  description:
    "Log a field-sales touch (door knock / call outcome). Writes the interaction to customer memory, applies the outcome's default nextStepText/nextStepDueAt/needsHuman unless the body overrides them, and auto-advances statusId per the outcome→status-key map resolved against this workspace's customer_statuses. When the PILE-412 stage gate refuses the advance, the touch still lands and the response flags stageBlocked.",
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: logInteractionBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Interaction logged",
      content: {
        "application/json": {
          schema: z.object({
            interaction: customerInteractionSchema,
            customer: customerSchema,
            stageAdvanced: z.boolean(),
            stageBlocked: z.boolean(),
          }),
        },
      },
    },
    404: { description: "Customer not found" },
  },
});

const deleteCustomerRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customers/{id}",
  tags: ["customers"],
  middleware: [rls("customer:delete")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Customer deleted" },
    404: { description: "Customer not found" },
  },
});

const purgeCustomersRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customers/purge",
  tags: ["customers"],
  middleware: [rls("customer:delete")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // Purge agent-sourced records by provenance stamp — the
            // agent slug OR a specific session. At least one required:
            // there is no "purge everything" path.
            sourcedBy: z.string().optional(),
            sourceSession: z.string().optional(),
            dryRun: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Purged agent-sourced customers",
      content: {
        "application/json": {
          schema: z.object({
            matched: z.number(),
            deleted: z.number(),
            ids: z.array(z.string()),
          }),
        },
      },
    },
  },
});

const attachmentParams = z.object({
  organizationId: z.string(),
  id: z.string(),
  attachmentId: z.string(),
});

const listCustomerAttachmentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers/{id}/attachments",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Customer attachments",
      content: {
        "application/json": {
          schema: z.object({
            attachments: z.array(customerAttachmentSchema),
          }),
        },
      },
    },
    404: { description: "Customer not found" },
  },
});

const uploadCustomerAttachmentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customers/{id}/attachments",
  tags: ["customers"],
  middleware: [rls("customer:create")],
  request: {
    params: orgIdParam,
    body: {
      content: {
        "application/json": { schema: uploadCustomerAttachmentSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Attachment uploaded",
      content: { "application/json": { schema: customerAttachmentSchema } },
    },
    404: { description: "Customer not found" },
    503: { description: "File storage not configured" },
  },
});

const getCustomerAttachmentRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers/{id}/attachments/{attachmentId}",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: attachmentParams },
  responses: {
    200: {
      description: "Customer attachment",
      content: { "application/json": { schema: customerAttachmentSchema } },
    },
    404: { description: "Attachment not found" },
  },
});

const getCustomerAttachmentContentRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers/{id}/attachments/{attachmentId}/content",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: attachmentParams },
  responses: {
    200: { description: "Attachment content" },
    404: { description: "Attachment not found" },
    503: { description: "File storage not configured" },
  },
});

const deleteCustomerAttachmentRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customers/{id}/attachments/{attachmentId}",
  tags: ["customers"],
  middleware: [rls("customer:delete")],
  request: { params: attachmentParams },
  responses: {
    204: { description: "Attachment deleted" },
    404: { description: "Attachment not found" },
  },
});

const listTiersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-tiers",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Customer tiers",
      content: {
        "application/json": {
          schema: z.object({ tiers: z.array(tierSchema) }),
        },
      },
    },
  },
});

const createTierRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customer-tiers",
  tags: ["customers"],
  middleware: [rls("customer:create")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: tierBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Tier created",
      content: { "application/json": { schema: tierSchema } },
    },
  },
});

const getTierRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-tiers/{id}",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Tier",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Tier not found" },
  },
});

const updateTierRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customer-tiers/{id}",
  tags: ["customers"],
  middleware: [rls("customer:edit")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: tierBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Tier updated",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Tier not found" },
  },
});

const deleteTierRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customer-tiers/{id}",
  tags: ["customers"],
  middleware: [rls("customer:delete")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Tier deleted" },
    404: { description: "Tier not found" },
  },
});

const listStatusesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-statuses",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Customer statuses",
      content: {
        "application/json": {
          schema: z.object({ statuses: z.array(tierSchema) }),
        },
      },
    },
  },
});

const createStatusRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customer-statuses",
  tags: ["customers"],
  middleware: [rls("customer:create")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: tierBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Status created",
      content: { "application/json": { schema: tierSchema } },
    },
  },
});

const getStatusRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-statuses/{id}",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Status",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Status not found" },
  },
});

const updateStatusRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customer-statuses/{id}",
  tags: ["customers"],
  middleware: [rls("customer:edit")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: tierBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Status updated",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Status not found" },
  },
});

const deleteStatusRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customer-statuses/{id}",
  tags: ["customers"],
  middleware: [rls("customer:delete")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Status deleted" },
    404: { description: "Status not found" },
  },
});

const listNeedsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-needs",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: {
    params: orgParam,
    query: z.object({
      customerId: z.string().optional(),
      issueId: z.string().optional(),
      projectId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Customer needs",
      content: {
        "application/json": {
          schema: z.object({ needs: z.array(needSchema) }),
        },
      },
    },
  },
});

const createNeedRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customer-needs",
  tags: ["customers"],
  middleware: [rls("customer:create")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: needBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Need created",
      content: { "application/json": { schema: needSchema } },
    },
  },
});

const getNeedRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-needs/{id}",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Need",
      content: { "application/json": { schema: needSchema } },
    },
    404: { description: "Need not found" },
  },
});

const updateNeedRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customer-needs/{id}",
  tags: ["customers"],
  middleware: [rls("customer:edit")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: needBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Need updated",
      content: { "application/json": { schema: needSchema } },
    },
    404: { description: "Need not found" },
  },
});

const deleteNeedRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customer-needs/{id}",
  tags: ["customers"],
  middleware: [rls("customer:delete")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Need deleted" },
    404: { description: "Need not found" },
  },
});

function toCustomerAttachmentResponse(
  row: typeof workspaceEntityAttachments.$inferSelect
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    customerId: row.entityId,
    fileName: row.fileName,
    contentType: row.contentType,
    size: row.size,
    r2Key: row.r2Key,
    url: `/workspaces/${row.organizationId}/customers/${row.entityId}/attachments/${row.id}/content`,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

async function getOwnedCustomerAttachment(
  stub: ReturnType<typeof getWorkspaceStub>,
  customerId: string,
  attachmentId: string
) {
  const row = await stub.getEntityAttachment(attachmentId);
  if (!row || row.entityType !== "customer" || row.entityId !== customerId) {
    return notFound("Attachment not found");
  }
  return row;
}

const listIntakeItemsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers/{id}/intake",
  tags: ["customers"],
  middleware: [rls("customer:view")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Customer intake items (inbound mail filed on the record)",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(intakeItemSchema) }),
        },
      },
    },
    404: { description: "Customer not found" },
  },
});

// Needs keep their row but drop `issueId` when it points at a restricted
// issue the caller can't see — the link alone proves the issue exists.
async function scrubNeedIssueId<T extends { issueId: string | null }>(
  c: Context<AppContext>,
  stub: ReturnType<typeof getWorkspaceStub>,
  need: T
): Promise<T> {
  if (!need.issueId) return need;
  const hidden = await hiddenIssueIdsForIdentity(
    createD1(c.env.D1),
    stub,
    c.var.workspaceIdentity
  );
  return hidden.includes(need.issueId) ? { ...need, issueId: null } : need;
}

async function loadCustomerSignals(
  stub: ReturnType<typeof getWorkspaceStub>,
  customerId: string
): Promise<MerchantSignal[]> {
  const facts = await stub.memoryRecall({
    entityType: "customer",
    entityId: customerId,
    limit: 100,
  });
  return parseCustomerSignalFacts(facts);
}

/** PILE-653 — `q` matches name, canonical domain, or url (rows without a
 *  domain still carry a url, so searching hosts needs both). */
export function customerMatchesQuery(
  row: { name?: string | null; domain?: string | null; url?: string | null },
  q: string
): boolean {
  return matchesSearchQuery([row.name, row.domain, row.url], q);
}

/** The `summary=1` projection — a plain pick so no heavy column leaks. */
export function toCustomerSummary(row: {
  id: string;
  name: string;
  domain: string | null;
  statusId: string | null;
  ownerId: string | null;
  nextStepText: string | null;
  nextStepDueAt: string | null;
  needsHuman: boolean | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    statusId: row.statusId,
    ownerId: row.ownerId,
    nextStepText: row.nextStepText,
    nextStepDueAt: row.nextStepDueAt,
    needsHuman: row.needsHuman,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerCustomerRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listCustomersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const {
      cold,
      dueBefore,
      needsHuman,
      externalId,
      domain,
      limit,
      cursor,
      q,
      summary,
    } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const allCustomers = await stub.listCustomers({
      cold: cold === "true",
      dueBefore,
      needsHuman: needsHuman === "true",
      externalId,
      domain,
    });
    const identity = c.var.workspaceIdentity;
    const isAdmin = isAdminIdentity(identity);
    const hasAssignedOwners = allCustomers.some((row) => row.ownerId !== null);
    const visibleCustomers =
      !isAdmin && identity.type === "user" && hasAssignedOwners
        ? allCustomers.filter((row) => row.ownerId === identity.id)
        : allCustomers;
    const searched = q
      ? visibleCustomers.filter((row) => customerMatchesQuery(row, q))
      : visibleCustomers;
    const { page, nextCursor } = pageByCreatedCursor(searched, {
      limit,
      cursor: cursor ? decodeCursor(cursor) : undefined,
    });
    const rows =
      summary === "1" || summary === "true"
        ? page.map(toCustomerSummary)
        : page;
    return c.json({
      customers: rows,
      nextCursor,
    });
  });

  app.openapi(createCustomerRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { dedupe } = c.req.valid("query");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    if (input.externalId) {
      const existing = await stub.getCustomerByExternalId(input.externalId);
      if (existing) {
        if (dedupe === "block") {
          throw new VortexError({
            code: "CONFLICT",
            status: 409,
            message: "externalId already used",
            hint: `Update customer ${existing.id} instead, or retry without dedupe=block`,
            details: { customer: existing },
          });
        }
        return c.json(existing, 200);
      }
    }
    const customer = await stub.createCustomer(input);
    return c.json(customer, 201);
  });

  app.openapi(importCustomersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const receipt = await stub.importCustomers(input, identity.id);
    return c.json(receipt, 200);
  });

  app.openapi(listImportReceiptsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    return c.json({ imports: await stub.listImportReceipts() });
  });

  app.openapi(getImportReceiptRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const receipt = await stub.getImportReceipt(id);
    if (!receipt) return notFound("Import receipt not found");
    return c.json(receipt);
  });

  app.openapi(getCustomerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    const identity = c.var.workspaceIdentity;
    if (
      customer.ownerId &&
      !isAdminIdentity(identity) &&
      identity.type === "user" &&
      customer.ownerId !== identity.id
    ) {
      return notFound("Customer not found");
    }
    return c.json(customer);
  });

  const listCustomerLeadContactsRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/customers/{id}/contacts",
    tags: ["customers"],
    middleware: [rls("customer:view")],
    request: { params: orgIdParam },
    responses: {
      200: {
        description: "Verified customer contacts (owners, emails, phones)",
        content: {
          "application/json": {
            schema: z.object({
              contacts: z.array(
                z.object({
                  id: z.string(),
                  customerId: z.string(),
                  type: z.string(),
                  role: z.string().nullable(),
                  channel: z.string(),
                  value: z.string(),
                  label: z.string().nullable(),
                  status: z.string(),
                  confidence: z.string().nullable(),
                  source: z.string().nullable(),
                  evidenceUri: z.string().nullable(),
                })
              ),
            }),
          },
        },
      },
    },
  });

  app.openapi(listCustomerLeadContactsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const contacts = await stub.listContacts(id);
    return c.json({
      contacts: contacts.map((ct) => ({
        id: ct.id,
        customerId: ct.customerId,
        type: ct.type,
        role: ct.role ?? null,
        channel: ct.channel,
        value: ct.value,
        label: ct.label ?? null,
        status: ct.status,
        confidence: ct.confidence ?? null,
        source: ct.source ?? null,
        evidenceUri: ct.evidenceUri ?? null,
      })),
    });
  });

  app.openapi(updateCustomerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    if (input.stageGateOverride !== undefined && !isAdminIdentity(identity)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "stageGateOverride requires admin",
      });
    }
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customer = await stub.updateCustomer(id, input, identity.id);
    if (!customer) return notFound("Customer not found");
    // PILE-401 — stage transitions emit domain events; drain them into
    // dispatches after the write (sweep is the backstop).
    getExecutionCtx(c)?.waitUntil(
      drainDomainEvents(c.env, stub, organizationId, getExecutionCtx(c))
    );
    return c.json(customer);
  });

  app.openapi(logCustomerInteractionRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const result = await stub.logCustomerInteraction(id, input, identity.id);
    if (!result) return notFound("Customer not found");
    // Stage auto-advance emits record.stage_entered — drain it into
    // dispatches like the PATCH path does (sweep is the backstop).
    getExecutionCtx(c)?.waitUntil(
      drainDomainEvents(c.env, stub, organizationId, getExecutionCtx(c))
    );
    return c.json(
      {
        interaction: {
          id: result.interactionId,
          customerId: id,
          outcome: input.outcome,
          note: input.note ?? null,
          createdAt: result.createdAt,
        },
        customer: result.customer,
        stageAdvanced: result.stageAdvanced,
        stageBlocked: result.stageBlocked,
      },
      201
    );
  });

  app.openapi(deleteCustomerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const deleted = await stub.deleteCustomer(id, identity.id);
    if (!deleted) return notFound("Customer not found");
    return c.body(null, 204);
  });

  app.openapi(purgeCustomersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!body.sourcedBy && !body.sourceSession)
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "sourcedBy or sourceSession required",
      });
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customers = await stub.listCustomers();
    const stamp = body.sourcedBy
      ? `[sourced-by:${body.sourcedBy}`
      : " session:";
    const sessionStamp = body.sourceSession
      ? `session:${body.sourceSession}`
      : null;
    const matches = customers.filter((cust) => {
      const notes = typeof cust.notes === "string" ? cust.notes : "";
      if (!notes.includes("[sourced-by:")) return false;
      if (body.sourcedBy && !notes.includes(stamp)) return false;
      if (sessionStamp && !notes.includes(sessionStamp)) return false;
      return true;
    });
    const ids = matches.map((cust) => cust.id);
    let deleted = 0;
    if (body.dryRun !== true) {
      for (const id of ids) {
        if (await stub.deleteCustomer(id, identity.id)) deleted += 1;
      }
    }
    return c.json({ matched: ids.length, deleted, ids }, 200);
  });

  app.openapi(listCustomerAttachmentsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    const items = await stub.listEntityAttachments("customer", id);
    return c.json({ attachments: items.map(toCustomerAttachmentResponse) });
  });

  app.openapi(uploadCustomerAttachmentRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    const row = await stub.storeEntityAttachment({
      entityType: "customer",
      entityId: id,
      fileName: input.fileName,
      contentType: input.contentType,
      dataBase64: input.contentBase64,
      createdById: identity.id,
    });
    return c.json(toCustomerAttachmentResponse(row), 201);
  });

  app.openapi(getCustomerAttachmentRoute, async (c) => {
    const { organizationId, id, attachmentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const row = await getOwnedCustomerAttachment(stub, id, attachmentId);
    return c.json(toCustomerAttachmentResponse(row));
  });

  app.openapi(getCustomerAttachmentContentRoute, async (c) => {
    const { organizationId, id, attachmentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const row = await getOwnedCustomerAttachment(stub, id, attachmentId);
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "File storage not configured",
      });
    }
    const object = await bucket.get(row.r2Key);
    if (!object || !object.body) {
      return notFound("Attachment content not found");
    }
    const safeFileName = row.fileName.replace(/["\\\r\n]/g, "_");
    const headers: Record<string, string> = {
      "content-type": object.httpMetadata?.contentType || row.contentType,
      "content-disposition": `attachment; filename="${safeFileName}"`,
      "x-content-type-options": "nosniff",
    };
    if (object.size) headers["content-length"] = String(object.size);
    return c.body(object.body, { headers });
  });

  app.openapi(deleteCustomerAttachmentRoute, async (c) => {
    const { organizationId, id, attachmentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const row = await getOwnedCustomerAttachment(stub, id, attachmentId);
    await stub.deleteEntityAttachment(row.id);
    return c.body(null, 204);
  });

  app.openapi(listTiersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    return c.json({ tiers: await stub.listCustomerTiers() });
  });

  app.openapi(createTierRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    return c.json(await stub.createCustomerTier(input), 201);
  });

  app.openapi(getTierRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const tier = await stub.getCustomerTier(id);
    if (!tier) return notFound("Tier not found");
    return c.json(tier);
  });

  app.openapi(updateTierRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const tier = await stub.updateCustomerTier(id, input);
    if (!tier) return notFound("Tier not found");
    return c.json(tier);
  });

  app.openapi(deleteTierRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    if (!(await stub.deleteCustomerTier(id))) return notFound("Tier not found");
    return c.body(null, 204);
  });

  app.openapi(listStatusesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    return c.json({ statuses: await stub.listCustomerStatuses() });
  });

  app.openapi(createStatusRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    return c.json(await stub.createCustomerStatus(input), 201);
  });

  app.openapi(getStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const status = await stub.getCustomerStatus(id);
    if (!status) return notFound("Status not found");
    return c.json(status);
  });

  app.openapi(updateStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const status = await stub.updateCustomerStatus(id, input);
    if (!status) return notFound("Status not found");
    return c.json(status);
  });

  app.openapi(deleteStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    if (!(await stub.deleteCustomerStatus(id)))
      return notFound("Status not found");
    return c.body(null, 204);
  });

  app.openapi(listNeedsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const needs = await stub.listCustomerNeeds({
      ...query,
      issueId:
        query.issueId === undefined
          ? undefined
          : await resolveVisibleIssueRef(db, stub, query.issueId, identity),
    });
    // Needs linked to issues the caller can't see keep the row but drop the
    // link — the issueId alone proves a restricted issue exists.
    const hidden = new Set(await hiddenIssueIdsForIdentity(db, stub, identity));
    return c.json({
      needs: needs.map((need) =>
        need.issueId && hidden.has(need.issueId)
          ? { ...need, issueId: null }
          : need
      ),
    });
  });

  app.openapi(createNeedRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const need = await stub.createCustomerNeed(
      {
        ...input,
        issueId:
          input.issueId === undefined
            ? undefined
            : await resolveVisibleIssueRef(
                createD1(c.env.D1),
                stub,
                input.issueId,
                identity
              ),
      },
      identity.id
    );
    return c.json(need, 201);
  });

  app.openapi(getNeedRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const need = await stub.getCustomerNeed(id);
    if (!need) return notFound("Need not found");
    return c.json(await scrubNeedIssueId(c, stub, need));
  });

  app.openapi(updateNeedRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const need = await stub.updateCustomerNeed(
      id,
      {
        ...input,
        issueId:
          input.issueId === undefined
            ? undefined
            : await resolveVisibleIssueRef(
                createD1(c.env.D1),
                stub,
                input.issueId,
                identity
              ),
      },
      identity.id
    );
    if (!need) return notFound("Need not found");
    return c.json(await scrubNeedIssueId(c, stub, need));
  });

  app.openapi(deleteNeedRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    if (!(await stub.deleteCustomerNeed(id))) return notFound("Need not found");
    return c.body(null, 204);
  });

  app.openapi(listIntakeItemsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    const items = await stub.listCustomerIntakeItems(id);
    return c.json({
      items: items.map((item) =>
        Object.assign(item, {
          attachments: item.attachments
            ? (JSON.parse(item.attachments) as z.infer<
                typeof intakeAttachmentSchema
              >[])
            : null,
        })
      ),
    });
  });

  // ---- PILE-478..533: Signals, Ranker v2, SMB Dedup & Send Gate API ----

  const recordSignalRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/{id}/signals",
    tags: ["customers"],
    middleware: [rls("customer:edit")],
    request: {
      params: orgIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              type: z.string().min(1).optional(),
              source: z.string().min(1).default("agent"),
              evidenceUrl: z.string().url(),
              strength: z.number().min(0).max(100).default(80),
              summary: z.string().optional(),
              observedAt: z.string().optional(),
              html: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Recorded signal and recomputed merchant rank",
        content: {
          "application/json": {
            schema: z.object({
              signal: z.record(z.string(), z.unknown()),
              breakdown: z.record(z.string(), z.unknown()),
              waterfall: z.array(z.string()),
            }),
          },
        },
      },
      404: { description: "Customer not found" },
    },
  });

  const listSignalsRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/customers/{id}/signals",
    tags: ["customers"],
    middleware: [rls("customer:view")],
    request: { params: orgIdParam },
    responses: {
      200: {
        description:
          "Customer signals, rank breakdown, and detective waterfall",
        content: {
          "application/json": {
            schema: z.object({
              customerId: z.string(),
              signals: z.array(z.record(z.string(), z.unknown())),
              breakdown: z.record(z.string(), z.unknown()),
              waterfall: z.array(z.string()),
            }),
          },
        },
      },
      404: { description: "Customer not found" },
    },
  });

  const evaluateCustomerSendGateRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/{id}/send-gate",
    tags: ["customers"],
    middleware: [rls("customer:view")],
    request: {
      params: orgIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              touchId: z.string().default("touch-preview"),
              channel: z.enum(["email", "call", "visit", "linkedin"]),
              action: z.enum(["engage", "claim"]).default("engage"),
              contactId: z.string().default("default-contact"),
              contactEmail: z.string().optional(),
              emailStatus: z
                .enum(["valid", "invalid", "catch_all", "role", "unknown"])
                .optional(),
              emailVerifiedAt: z.string().optional(),
              doNotContact: z.boolean().optional(),
              doNotEmail: z.boolean().optional(),
              doNotCall: z.boolean().optional(),
              euResident: z.boolean().optional(),
              hasExplicitConsent: z.boolean().optional(),
              allowCatchAll: z.boolean().optional(),
              allowRole: z.boolean().optional(),
              allowUnverified: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Deterministic send/claim GateDecision",
        content: {
          "application/json": {
            schema: z.object({
              touchId: z.string(),
              channel: z.string(),
              result: z.enum(["pass", "warn", "block"]),
              reasons: z.array(z.string()),
              matchedExclusions: z.array(z.string()),
              evaluatedAt: z.string(),
            }),
          },
        },
      },
      404: { description: "Customer not found" },
    },
  });

  const dedupKeyRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/dedup-key",
    tags: ["customers"],
    middleware: [rls("customer:view")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              address: z.string().nullable().optional(),
              phone: z.string().nullable().optional(),
              domain: z.string().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Normalized SMB match key and any matching existing customer",
        content: {
          "application/json": {
            schema: z.object({
              matchKey: z.string(),
              normalizedName: z.string(),
              normalizedAddress: z.string(),
              phoneE164: z.string(),
              normalizedDomain: z.string(),
              matchedCustomerId: z.string().nullable(),
            }),
          },
        },
      },
    },
  });

  app.openapi(recordSignalRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    const evaluationNowIso = new Date().toISOString();
    const observedAt = input.observedAt ?? evaluationNowIso;

    let signal: MerchantSignal;
    let posGuess: string | null = null;
    if (input.html) {
      const detected = detectPosTechnographics({
        merchantId: customer.id,
        pageUrl: input.evidenceUrl,
        html: input.html,
        observedAt,
      });
      posGuess = detected.posGuess;
      if (detected.signal) {
        signal = detected.signal;
      } else {
        signal = {
          id: `sig_${crypto.randomUUID().slice(0, 12)}`,
          merchantId: customer.id,
          type: input.type ?? "pos_detected",
          observedAt,
          source: input.source,
          evidenceUrl: input.evidenceUrl,
          strength: input.strength,
          summary: input.summary ?? null,
        };
      }
    } else {
      const sigType = input.type ?? "new_license";
      signal = {
        id: `sig_${crypto.randomUUID().slice(0, 12)}`,
        merchantId: customer.id,
        type: sigType,
        observedAt,
        source: input.source,
        evidenceUrl: input.evidenceUrl,
        strength: input.strength,
        summary: input.summary ?? null,
      };
    }

    await stub.memoryRemember({
      entityType: "customer",
      entityId: customer.id,
      kind: `signal:${signal.type}:${signal.id}`,
      fact: JSON.stringify(signal),
    });

    const signals = await loadCustomerSignals(stub, customer.id);
    const breakdown = rankMerchantSignals({
      merchantId: customer.id,
      merchantAttrs: {
        vertical: (customer.vertical ?? "").toLowerCase(),
        hasAddress: Boolean(customer.address),
        hasPhone: Boolean(customer.phone),
      },
      signals,
      config: {
        motion: "smb_default",
        icpRules: DEFAULT_ICP_RULES,
        signalRules: DEFAULT_SIGNAL_RULES,
      },
      nowIso: evaluationNowIso,
    });
    const customFields: Record<string, string | null> =
      typeof customer.customFields === "string"
        ? (JSON.parse(customer.customFields) as Record<string, string | null>)
        : {
            ...(customer.customFields as Record<string, string | null> | null),
          };
    customFields.whyNow = breakdown.whyNow;
    customFields.whyNowSignalIds = breakdown.whyNowSignalIds.join(",");
    await stub.updateCustomer(customer.id, {
      priorityScore: breakdown.priorityScore,
      fitScore: breakdown.fitScore,
      fitStatus: breakdown.fitRating,
      ...(posGuess ? { processor: posGuess } : {}),
      evidenceUri: signal.evidenceUrl,
      customFields,
    });

    const waterfall = planDetectiveWaterfall({
      rankScore: breakdown.priorityScore,
      paidRankThreshold: 75,
      monthlyBudgetRemainingCents: 10_000,
      estimatedPaidLookupCents: 50,
    });
    return c.json(
      {
        signal: signal as unknown as Record<string, unknown>,
        breakdown: breakdown as unknown as Record<string, unknown>,
        waterfall,
      },
      201
    );
  });

  app.openapi(listSignalsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    const signals = await loadCustomerSignals(stub, customer.id);
    const breakdown = rankMerchantSignals({
      merchantId: customer.id,
      merchantAttrs: {
        vertical: (customer.vertical ?? "").toLowerCase(),
        hasAddress: Boolean(customer.address),
        hasPhone: Boolean(customer.phone),
      },
      signals,
      config: {
        motion: "smb_default",
        icpRules: DEFAULT_ICP_RULES,
        signalRules: DEFAULT_SIGNAL_RULES,
      },
    });
    const waterfall = planDetectiveWaterfall({
      rankScore: breakdown.priorityScore,
      paidRankThreshold: 75,
      monthlyBudgetRemainingCents: 10_000,
      estimatedPaidLookupCents: 50,
    });
    return c.json({
      customerId: customer.id,
      signals: signals as unknown as Array<Record<string, unknown>>,
      breakdown: breakdown as unknown as Record<string, unknown>,
      waterfall,
    });
  });

  app.openapi(evaluateCustomerSendGateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");

    const suppressedCustomer = await stub.isSuppressed(
      "customerId",
      customer.id
    );
    const suppressedDomain = customer.domain
      ? await stub.isSuppressed("domain", customer.domain)
      : null;
    const suppressedEmail = input.contactEmail
      ? await stub.isSuppressed("email", input.contactEmail)
      : null;

    const decision = evaluateSendGate({
      touchId: input.touchId,
      channel: input.channel as TouchChannel,
      action: input.action,
      merchant: {
        id: customer.id,
        domain: customer.domain,
        permissions: {
          doNotContact:
            Boolean(input.doNotContact) ||
            Boolean(suppressedCustomer) ||
            Boolean(suppressedDomain),
        },
      },
      contact: {
        id: input.contactId,
        email: input.contactEmail ?? null,
        permissions: {
          doNotEmail: Boolean(input.doNotEmail) || Boolean(suppressedEmail),
          doNotCall: Boolean(input.doNotCall),
          euResident: Boolean(input.euResident),
          hasExplicitConsent: Boolean(input.hasExplicitConsent),
          emailStatus: (input.emailStatus ??
            "valid") as EmailVerificationStatus,
          emailVerifiedAt: input.emailVerifiedAt ?? null,
        },
      },
      cadence: {
        allowCatchAll: input.allowCatchAll,
        allowRole: input.allowRole,
        allowUnverified: input.allowUnverified ?? true,
      },
    });

    await stub.memoryRemember({
      entityType: "customer",
      entityId: customer.id,
      kind: `gate_decision:${decision.touchId}`,
      fact: JSON.stringify(decision),
    });

    return c.json(decision);
  });

  app.openapi(dedupKeyRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const key = computeSmbMatchKey(input);
    const allCustomers = await stub.listCustomers();
    const matched = allCustomers.find((row) => {
      const rowKey = computeSmbMatchKey({
        name: row.name,
        address: row.address,
        phone: row.phone,
        domain: row.domain,
      });
      return (
        rowKey.matchKey === key.matchKey ||
        (Boolean(key.normalizedDomain) &&
          rowKey.normalizedDomain === key.normalizedDomain)
      );
    });
    return c.json({
      ...key,
      matchedCustomerId: matched?.id ?? null,
    });
  });

  const replyIngestRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/{id}/reply-ingest",
    tags: ["customers"],
    middleware: [rls("customer:edit")],
    request: {
      params: orgIdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              subject: z.string().default(""),
              body: z.string().min(1),
              fromEmail: z.string().optional(),
              statementFileId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Classified 16-category Unify reply, applied opt-out/bounce suppression, and created statement checklist if applicable",
        content: {
          "application/json": {
            schema: z.object({
              classified: z.record(z.string(), z.unknown()),
              suppressed: z.boolean(),
              enrollment: z.record(z.string(), z.unknown()),
              tasks: z.array(z.record(z.string(), z.unknown())),
              statementChecklist: z.record(z.string(), z.unknown()).nullable(),
            }),
          },
        },
      },
      404: { description: "Customer not found" },
    },
  });

  app.openapi(replyIngestRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");

    const classified = classifyInboundReply(
      input.subject,
      input.body,
      undefined,
      input.fromEmail
    );
    let suppressed = false;
    if (classified.category === "opt_out") {
      suppressed = true;
      await stub.upsertSuppression({
        kind: "customerId",
        value: customer.id,
        customerId: customer.id,
        reason: "reply:opt_out",
        source: "reply_ingest",
      });
      if (input.fromEmail) {
        await stub.upsertSuppression({
          kind: "email",
          value: input.fromEmail,
          customerId: customer.id,
          reason: "reply:opt_out",
          source: "reply_ingest",
        });
      }
    } else if (classified.category === "hard_bounce" && input.fromEmail) {
      suppressed = true;
      await stub.upsertSuppression({
        kind: "email",
        value: input.fromEmail,
        customerId: customer.id,
        reason: "reply:hard_bounce",
        source: "reply_ingest",
      });
    }

    const outcome = applyInboundReplyOutcome({
      enrollment: {
        id: `enr_${customer.id}`,
        merchantId: customer.id,
        contactId: input.fromEmail ?? "default-contact",
        cadenceId: "default",
        cadenceVersion: 1,
        mailboxId: "default",
        status: "active",
        enrolledBy: "system",
        touches: [],
      },
      contactPermissions: { emailStatus: "valid" },
      classified,
      existingTasks: [],
    });

    // PILE-603: Wire referral / updated_contact_info -> DecisionMakerPointer contact + Bookkeeper/CPA Partner auto-link
    let referredPartnerCustomerId: string | null = null;
    if (
      classified.alternateContactEmail &&
      (classified.category === "referral" ||
        classified.category === "updated_contact_info")
    ) {
      await stub.upsertContact({
        customerId: customer.id,
        type: "named_person",
        role: classified.referralRole ?? "decision_maker",
        channel: "email",
        value: classified.alternateContactEmail,
        label:
          classified.referralRole === "bookkeeper_cpa"
            ? `${customer.name} Bookkeeper / CPA`
            : `${customer.name} Referral Contact`,
        status: "verified",
        confidence: "high",
        source: "reply_referral",
      });

      if (classified.referralRole === "bookkeeper_cpa") {
        const { deriveDomainFromEmail } =
          await import("../agents/collectors.js");
        const partnerDomain = deriveDomainFromEmail(
          classified.alternateContactEmail
        );
        const existingPartners = partnerDomain
          ? await stub.listCustomers({ domain: partnerDomain })
          : [];
        const partnerCustomer =
          existingPartners[0] ??
          // externalId is the dedupe key — repeat referral replies mentioning
          // the same bookkeeper email resolve to one partner record, including
          // freemail domains where partnerDomain is null.
          (await stub.createCustomer({
            name: partnerDomain
              ? `${partnerDomain.split(".")[0]!.toUpperCase()} CPA & BOOKKEEPING`
              : `${customer.name} Bookkeeper Partner`,
            domain: partnerDomain ?? null,
            externalId: `referral:${classified.alternateContactEmail}`,
            vertical: "Bookkeeper / CPA Partner",
            ownerId:
              organizationId === "org_vortex_main"
                ? VORTEX_MAIN_PARTNER_OWNER_ID
                : null,
            signal: `Referred by ${customer.name} (${classified.alternateContactEmail})`,
            source: "reply_referral",
          }));
        referredPartnerCustomerId = partnerCustomer.id;
        await stub.upsertContact({
          customerId: partnerCustomer.id,
          type: "named_person",
          role: "owner",
          channel: "email",
          value: classified.alternateContactEmail,
          label: partnerCustomer.name,
          status: "verified",
          confidence: "high",
          source: "reply_referral",
        });
      }
    }

    // PILE-604: Deferred recontactAt window (3/6/12 months) on bad_timing /
    // budget replies. Never clobber a human-set future next step — only stamp
    // when the field is empty, already ours, or expired.
    if (classified.category === "bad_timing" && classified.recontactAtIso) {
      const existingDueMs = customer.nextStepDueAt
        ? Date.parse(customer.nextStepDueAt)
        : Number.NaN;
      const isOurDeferral =
        customer.nextStepText?.startsWith("recontact:") ?? false;
      const stepExpired =
        Number.isFinite(existingDueMs) && existingDueMs <= Date.now();
      if (
        !customer.nextStepDueAt ||
        isOurDeferral ||
        !Number.isFinite(existingDueMs) ||
        stepExpired
      ) {
        await stub.updateCustomer(customer.id, {
          nextStepDueAt: classified.recontactAtIso,
          nextStepText: `recontact: bad_timing (${classified.recontactWindowMonths ?? 3}mo)`,
        });
      }
    }

    const statementChecklist = input.statementFileId
      ? createStatementReceivedChecklist({
          merchantId: customer.id,
          statementFileId: input.statementFileId,
        })
      : null;

    await stub.memoryRemember({
      entityType: "customer",
      entityId: customer.id,
      kind: `reply:${Date.now()}`,
      fact: JSON.stringify({
        classified,
        fromEmail: input.fromEmail ?? null,
        suppressed,
        referredPartnerCustomerId,
        enrollmentStatus: outcome.enrollment.status,
        pausedUntil: outcome.enrollment.pausedUntil ?? null,
        tasks: outcome.tasks,
        statementChecklist,
      }),
    });

    return c.json({
      classified: {
        ...(classified as unknown as Record<string, unknown>),
        referredPartnerCustomerId,
      },
      suppressed,
      enrollment: outcome.enrollment as unknown as Record<string, unknown>,
      tasks: outcome.tasks as unknown as Array<Record<string, unknown>>,
      statementChecklist: statementChecklist as unknown as Record<
        string,
        unknown
      > | null,
    });
  });

  // PILE-514..517: Dynamic Saved Audience Query (AND/OR filter builder)
  const audiencePredicateSchema = z.object({
    field: z.string().min(1),
    op: z.enum(["eq", "neq", "in", "gte", "lte", "contains", "has_signal"]),
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number()])),
    ]),
  });

  const audienceQueryRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/audience-query",
    tags: ["customers"],
    middleware: [rls("customer:view", "workspace:read")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              logic: z.enum(["and", "or"]).default("and"),
              predicates: z.array(audiencePredicateSchema).default([]),
              limit: z.number().int().min(1).max(200).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Matched customers for dynamic audience filter",
        content: {
          "application/json": {
            schema: z.object({
              totalMatched: z.number(),
              merchants: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
    },
  });

  app.openapi(audienceQueryRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const all = await stub.listCustomers();
    const candidates: AudienceCandidateMerchant[] = await Promise.all(
      all.map(async (cust) => {
        const suppCust = await stub.isSuppressed("customerId", cust.id);
        const suppDomain = cust.domain
          ? await stub.isSuppressed("domain", cust.domain)
          : null;
        const suppressed = Boolean(suppCust) || Boolean(suppDomain);
        const facts = await stub.memoryRecall({
          entityType: "customer",
          entityId: cust.id,
          limit: 50,
        });
        const signals = parseCustomerSignalFacts(facts);
        let whyNow: string | null = cust.signal ?? null;
        if (!whyNow && cust.customFields) {
          try {
            const parsed =
              typeof cust.customFields === "string"
                ? (JSON.parse(cust.customFields) as Record<string, unknown>)
                : (cust.customFields as Record<string, unknown>);
            if (typeof parsed?.whyNow === "string") whyNow = parsed.whyNow;
          } catch {
            whyNow = null;
          }
        }
        return {
          id: cust.id,
          name: cust.name,
          domain: cust.domain,
          vertical: cust.vertical,
          neighborhood: cust.neighborhood,
          address: cust.address,
          phone: cust.phone,
          processor: cust.processor,
          ownerId: cust.ownerId,
          priorityScore: cust.priorityScore,
          fitScore: cust.fitScore,
          fitStatus: cust.fitStatus,
          suppressed,
          signalTypes: [...new Set(signals.map((s) => s.type))],
          whyNow,
        };
      })
    );

    const filter: AudienceFilterGroup = {
      logic: input.logic,
      predicates: input.predicates,
    };
    const matched = queryDynamicAudience(candidates, filter, input.limit ?? 50);
    return c.json({
      totalMatched: matched.length,
      merchants: matched as unknown as Array<Record<string, unknown>>,
    });
  });

  // PILE-521..527: Run Autonomous Lead Play on Customer (Profiler -> Detective -> SendGate -> Drafter)
  const runPlayRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/{id}/run-play",
    tags: ["customers"],
    middleware: [rls("customer:edit", "workspace:write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              playName: z.string().optional(),
              html: z.string().optional(),
              pageUrl: z.string().optional(),
              contactEmail: z.string().optional(),
              minDraftRankScore: z.number().optional(),
              paidRankThreshold: z.number().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Executed lead play and queued awaiting_approval draft",
        content: {
          "application/json": {
            schema: z.record(z.string(), z.unknown()),
          },
        },
      },
      404: { description: "Customer not found" },
    },
  });

  app.openapi(runPlayRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Customer not found",
      });
    }

    const facts = await stub.memoryRecall({
      entityType: "customer",
      entityId: customer.id,
      limit: 100,
    });
    const priorSignals = parseCustomerSignalFacts(facts);
    const suppCust = await stub.isSuppressed("customerId", customer.id);
    const suppDomain = customer.domain
      ? await stub.isSuppressed("domain", customer.domain)
      : null;
    const suppEmail = input.contactEmail
      ? await stub.isSuppressed("email", input.contactEmail)
      : null;

    const receipt = runMerchantLeadPlay({
      merchant: {
        id: customer.id,
        name: customer.name,
        domain: customer.domain,
        vertical: customer.vertical,
        neighborhood: customer.neighborhood,
        address: customer.address,
        phone: customer.phone,
        processor: customer.processor,
        ownerId: customer.ownerId,
        priorityScore: customer.priorityScore,
        fitScore: customer.fitScore,
        fitStatus: customer.fitStatus,
      },
      signals: priorSignals,
      html: input.html,
      pageUrl: input.pageUrl,
      playName: input.playName,
      contactEmail: input.contactEmail,
      minDraftRankScore: input.minDraftRankScore,
      paidRankThreshold: input.paidRankThreshold,
      suppressed: Boolean(suppCust),
      domainSuppressed: Boolean(suppDomain),
      emailSuppressed: Boolean(suppEmail),
      actorUserId: c.var.workspaceIdentity.id,
    });

    await stub.updateCustomer(customer.id, {
      priorityScore: receipt.breakdown.priorityScore,
      fitScore: receipt.breakdown.fitScore,
      fitStatus: receipt.breakdown.fitRating,
      signal: receipt.breakdown.whyNow,
      ...(receipt.posGuess ? { processor: receipt.posGuess } : {}),
    });

    if (receipt.newSignal) {
      await stub.memoryRemember({
        entityType: "customer",
        entityId: customer.id,
        kind: `signal:${receipt.newSignal.type}:${receipt.newSignal.id}`,
        fact: JSON.stringify(receipt.newSignal),
      });
    }
    await stub.memoryRemember({
      entityType: "customer",
      entityId: customer.id,
      kind: `play_run:${receipt.playName}`,
      fact: JSON.stringify(receipt),
    });

    return c.json(receipt as unknown as Record<string, unknown>);
  });

  // PILE-559: Daily Rep Morning Brief
  const morningBriefRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/morning-brief",
    tags: ["customers"],
    middleware: [rls("customer:view", "workspace:read")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              ownerId: z.string().optional(),
              limit: z.number().int().min(1).max(100).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Ranked daily rep morning brief with why-now and next action",
        content: {
          "application/json": {
            schema: z.object({
              generatedAt: z.string(),
              totalCandidates: z.number(),
              items: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
    },
  });

  app.openapi(morningBriefRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const allRaw = await stub.listCustomers();
    const nowMs = Date.now();
    // PILE-604: Only our own "recontact:" deferrals hide a customer from the
    // brief — a human-set future nextStepDueAt (demo, proposal) keeps them in.
    const all = allRaw.filter((cust) => {
      if (!cust.nextStepText?.startsWith("recontact:")) return true;
      if (!cust.nextStepDueAt) return true;
      const dueMs = Date.parse(cust.nextStepDueAt);
      return !Number.isFinite(dueMs) || dueMs <= nowMs;
    });
    const candidates: AudienceCandidateMerchant[] = await Promise.all(
      all.map(async (cust) => {
        const suppCust = await stub.isSuppressed("customerId", cust.id);
        const suppDomain = cust.domain
          ? await stub.isSuppressed("domain", cust.domain)
          : null;
        const suppressed = Boolean(suppCust) || Boolean(suppDomain);
        let whyNow: string | null = cust.signal ?? null;
        if (!whyNow && cust.customFields) {
          try {
            const parsed =
              typeof cust.customFields === "string"
                ? (JSON.parse(cust.customFields) as Record<string, unknown>)
                : (cust.customFields as Record<string, unknown>);
            if (typeof parsed?.whyNow === "string") whyNow = parsed.whyNow;
          } catch {
            whyNow = null;
          }
        }
        return {
          id: cust.id,
          name: cust.name,
          domain: cust.domain,
          vertical: cust.vertical,
          neighborhood: cust.neighborhood,
          address: cust.address,
          phone: cust.phone,
          processor: cust.processor,
          ownerId: cust.ownerId,
          priorityScore: cust.priorityScore,
          fitScore: cust.fitScore,
          fitStatus: cust.fitStatus,
          suppressed,
          whyNow,
        };
      })
    );

    const brief = buildRepMorningBrief({
      merchants: candidates,
      ownerId: query.ownerId,
      limit: query.limit ?? 15,
    });
    return c.json({
      generatedAt: brief.generatedAt,
      totalCandidates: brief.totalCandidates,
      items: brief.items as unknown as Array<Record<string, unknown>>,
    });
  });

  // Autonomous Non-POS SMB Lead Pull, Dedup, Signal Record & Play Runner
  const pullLeadsRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/pull-leads",
    tags: ["customers"],
    middleware: [rls("customer:edit", "workspace:write")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              preset: z
                .enum([
                  "nyc_dob_contractors_and_trades",
                  "nyc_bic_commercial_haulers",
                  "nyc_dob_permit_issuances",
                  "nyc_home_improvement_contractors",
                  "nyc_auto_and_garages",
                  "nyc_b2b_and_specialty_dealers",
                  "nyc_bookkeepers_and_cpas",
                  "nyc_vc_and_accelerators",
                  "nyc_tech_and_software_startups",
                  "us_nppes_medical_and_dental",
                  "us_sec_form_d_tech_startups",
                ])
                .default("nyc_dob_contractors_and_trades"),
              borough: z.string().optional(),
              limit: z.number().int().min(1).max(100).default(15),
              offset: z.number().int().min(0).optional(),
              ownerId: z.string().optional(),
              enrichWebsites: z.boolean().default(true),
              dispatchDetectiveBatch: z.boolean().default(false),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Pulled non-POS SMB leads from public registries, deduplicated via SMB match key, created owner contacts, recorded signals, and executed lead play",
        content: {
          "application/json": {
            schema: z.object({
              sourceName: z.string(),
              pulledCount: z.number(),
              createdCount: z.number(),
              updatedCount: z.number(),
              nextOffset: z.number(),
              detectiveBatchIssueId: z.string().nullable().optional(),
              leads: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
    },
  });

  app.openapi(pullLeadsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const source =
      PRESET_NON_POS_SMB_SOURCES[input.preset as NonPosSmbPresetId];
    const cursorKind = `lead_cursor:${input.preset}`;
    let offset = input.offset;
    if (offset === undefined) {
      const cursorRows = await stub.memoryRecall({
        entityType: "workspace",
        entityId: organizationId,
        kind: cursorKind,
        limit: 1,
      });
      const stored = Number(cursorRows[0]?.fact ?? 0);
      offset = Number.isFinite(stored) && stored >= 0 ? stored : 0;
    }

    const sourceCfg = JSON.parse(source.config) as { borough_field?: string };
    const boroughCol = sourceCfg.borough_field ?? "address_borough";
    const extraWhere = input.borough
      ? `upper(${boroughCol})=upper('${input.borough.replace(/'/g, "")}')`
      : undefined;
    const pulled = await pullSource(source, undefined, {
      limit: input.limit,
      offset,
      extraWhere,
    });
    const nextOffset = offset + pulled.candidates.length;
    const candidates = input.enrichWebsites
      ? await (async () => {
          const { Effect } = await import("effect");
          const { enrichCandidatesWithEffect } =
            await import("../agents/collectors-effect.js");
          const envVars = c.env as unknown as Record<
            string,
            string | undefined
          >;
          return Effect.runPromise(
            enrichCandidatesWithEffect(pulled.candidates, {
              concurrency: 6,
              timeoutMs: 2500,
              scraplingBaseUrl:
                envVars.SCRAPLING_BASE_URL ?? "https://scrapling.pile.nyc",
              obscuraBaseUrl:
                envVars.OBSCURA_BASE_URL ?? "https://obscura.pile.nyc",
              firecrawlBaseUrl:
                envVars.FIRECRAWL_BASE_URL ?? "https://firecrawl.pile.nyc",
              lookupDos: true,
            })
          );
        })()
      : pulled.candidates;

    const defaultOwnerId =
      input.ownerId ??
      (organizationId === "org_vortex_main"
        ? input.preset === "nyc_tech_and_software_startups" ||
          input.preset === "us_sec_form_d_tech_startups" ||
          input.preset === "nyc_vc_and_accelerators" ||
          input.preset === "nyc_bookkeepers_and_cpas"
          ? "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE"
          : "ecH8c2QyUL9IldR7F59YLtvG58s76UIh"
        : null);

    const batchResult = await stub.ingestPulledLeadsBatch({
      sourceName: source.name,
      cursorKind,
      nextOffset,
      actorUserId: c.var.workspaceIdentity.id,
      defaultOwnerId,
      dispatchDetectiveBatch: input.dispatchDetectiveBatch,
      candidates,
    });

    if (batchResult.detectiveBatchIssueId) {
      getExecutionCtx(c)?.waitUntil(
        drainDomainEvents(c.env, stub, organizationId, getExecutionCtx(c))
      );
    }

    return c.json(batchResult);
  });

  // Effect.partition Batch Approval & Send-Gate Runner
  const approveBatchRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/approve-batch",
    tags: ["customers"],
    middleware: [rls("customer:edit", "workspace:write")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              customerIds: z.array(z.string()).optional(),
              channel: z
                .enum(["email", "call", "visit", "sms"])
                .default("call"),
              limit: z.number().int().min(1).max(100).default(25),
              // PILE-609 — optional cold-email cadence wiring for
              // channel=email batches: mailbox identity, cap override,
              // and DNS health gate flow into executeReadyTouch.
              mailboxId: z.string().optional(),
              dailyCap: z.number().int().min(1).max(500).optional(),
              domainHealth: z
                .object({
                  domain: z.string(),
                  spfOk: z.boolean(),
                  dkimOk: z.boolean(),
                  dmarcOk: z.boolean(),
                  mxOk: z.boolean(),
                  checkedAt: z.string().optional(),
                })
                .optional(),
              unsubscribeBaseUrl: z.string().optional(),
              physicalAddress: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Evaluated Send Gate across the batch using Effect.partition and separated approved vs blocked leads",
        content: {
          "application/json": {
            schema: z.object({
              approvedCount: z.number(),
              blockedCount: z.number(),
              approved: z.array(
                z.object({
                  customerId: z.string(),
                  name: z.string(),
                  channel: z.string(),
                  recipient: z.string().nullable(),
                  optOutFooter: z.string().nullable().optional(),
                  enrollmentStatus: z.string().optional(),
                  mailboxSentToday: z.number().optional(),
                })
              ),
              blocked: z.array(
                z.object({
                  customerId: z.string(),
                  name: z.string(),
                  reasons: z.array(z.string()),
                })
              ),
            }),
          },
        },
      },
    },
  });

  app.openapi(approveBatchRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const allCustomers = await stub.listCustomers();
    const idSet = input.customerIds ? new Set(input.customerIds) : null;
    const selected = allCustomers
      .filter((row) =>
        idSet ? idSet.has(row.id) : (row.priorityScore ?? 0) > 0
      )
      .toSorted((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
      .slice(0, input.limit);

    // Business day keyed on recipient time, not UTC midnight.
    const todayYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(new Date());
    const preSendKind = `pre_send:${input.channel}:${todayYmd}`;

    const candidates = await Promise.all(
      selected.map(async (cust) => {
        const contacts = await stub.listContacts(cust.id);
        const emailContact = contacts.find((ct) => ct.channel === "email");
        const [suppCust, suppEmail, existingReservation] = await Promise.all([
          stub.isSuppressed("customerId", cust.id),
          emailContact?.value
            ? stub.isSuppressed("email", emailContact.value)
            : Promise.resolve(null),
          stub.memoryRecall({
            entityType: "customer",
            entityId: cust.id,
            kind: preSendKind,
            limit: 1,
          }),
        ]);
        const alreadyReservedToday = existingReservation.length > 0;
        return {
          customerId: cust.id,
          name: cust.name,
          channel: input.channel as TouchChannel,
          contactEmail: emailContact?.value ?? null,
          phone: cust.phone,
          address: cust.address,
          suppressedCustomer: Boolean(suppCust) || alreadyReservedToday,
          suppressedEmail: Boolean(suppEmail),
        };
      })
    );

    const { Effect } = await import("effect");
    const { evaluateApprovedBatchWithEffect } =
      await import("../agents/collectors-effect.js");

    // PILE-609 — for email batches, hydrate the per-mailbox daily state from
    // workspace memory, apply cap/DNS-health overrides, run the cadence
    // pipeline inside evaluateApprovedBatchWithEffect, then persist the
    // advanced sentToday counter back for the next batch.
    let mailboxState:
      | import("../workspace/cadence-engine.js").OutboundMailbox
      | undefined;
    let domainHealthGate:
      | import("../workspace/cadence-engine.js").SendingDomainHealth
      | undefined;
    if (input.channel === "email") {
      const {
        DEFAULT_COLD_MAILBOX_DAILY_CAP,
        pauseMailboxesForUnhealthyDomain,
        updateMailboxDailyCap,
      } = await import("../workspace/cadence-engine.js");
      const mailboxId = input.mailboxId ?? "default";
      const mailboxKind = `mailbox:${mailboxId}:${todayYmd}`;
      const recalled = await stub
        .memoryRecall({
          entityType: "workspace",
          entityId: organizationId,
          kind: mailboxKind,
          limit: 1,
        })
        .catch(() => []);
      let storedSentToday = 0;
      if (recalled.length > 0) {
        try {
          const parsed = JSON.parse(recalled[0]!.fact) as {
            sentToday?: number;
            rampStartedAt?: string;
          };
          storedSentToday = parsed.sentToday ?? 0;
        } catch {
          storedSentToday = 0;
        }
      }
      const domain = input.domainHealth?.domain ?? "cold.vortex.dev";
      mailboxState = {
        id: mailboxId,
        address: `outbound@${domain}`,
        domain,
        ownerUserId: "system",
        provider: "smtp",
        state: "connected",
        dailyCap: DEFAULT_COLD_MAILBOX_DAILY_CAP,
        rampStartedAt: todayYmd,
        sentToday: storedSentToday,
      };
      if (input.dailyCap) {
        mailboxState = updateMailboxDailyCap(mailboxState, input.dailyCap);
      }
      if (input.domainHealth) {
        domainHealthGate = {
          ...input.domainHealth,
          checkedAt: input.domainHealth.checkedAt ?? new Date().toISOString(),
        };
        mailboxState =
          pauseMailboxesForUnhealthyDomain([mailboxState], domainHealthGate)
            .mailboxes[0] ?? mailboxState;
      }
    }

    const partitioned = await Effect.runPromise(
      evaluateApprovedBatchWithEffect(candidates, {
        concurrency: 5,
        ...(mailboxState ? { mailbox: mailboxState } : {}),
        ...(domainHealthGate ? { domainHealth: domainHealthGate } : {}),
        ...(input.unsubscribeBaseUrl
          ? {
              unsubscribeUrl: input.unsubscribeBaseUrl,
            }
          : {}),
        ...(input.physicalAddress
          ? { physicalAddress: input.physicalAddress }
          : {}),
        schedule: {
          timeZone: "America/New_York",
          businessHours: { startHour: 9, endHour: 18 },
        },
      })
    );

    if (mailboxState && input.channel === "email") {
      const mailboxId = input.mailboxId ?? "default";
      const mailboxKind = `mailbox:${mailboxId}:${todayYmd}`;
      const maxSent = partitioned.approved.reduce(
        (acc, item) => Math.max(acc, item.mailboxSentToday ?? 0),
        mailboxState.sentToday
      );
      await stub
        .memoryRemember({
          entityType: "workspace",
          entityId: organizationId,
          kind: mailboxKind,
          fact: JSON.stringify({
            mailboxId,
            sentToday: maxSent,
            rampStartedAt: todayYmd,
            updatedAt: new Date().toISOString(),
          }),
        })
        .catch(() => null);
    }

    // PILE-608: Atomic check-then-write inside the DO — two overlapping
    // approve-batch calls cannot both reserve the same lead for the same day.
    const nowIso = new Date().toISOString();
    const claims = await Promise.all(
      partitioned.approved.map((item) =>
        stub.claimMemoryOnce({
          entityType: "customer",
          entityId: item.customerId,
          kind: preSendKind,
          fact: JSON.stringify({
            customerId: item.customerId,
            name: item.name,
            channel: item.channel,
            recipient: item.recipient,
            reservedAt: nowIso,
            status: "reserved",
          }),
        })
      )
    );
    const approved = partitioned.approved.filter((_, i) => claims[i]);
    const claimBlocked = partitioned.approved
      .filter((_, i) => !claims[i])
      .map((item) => ({
        customerId: item.customerId,
        name: item.name,
        reasons: ["ALREADY_RESERVED_TODAY"],
      }));
    const blocked = [...partitioned.blocked, ...claimBlocked];

    captureProductEvent(
      "customer.batch_approved",
      {
        organizationId,
        actorId: c.var.workspaceIdentity?.id,
        channel: input.channel,
        approvedCount: partitioned.approved.length,
        blockedCount: partitioned.blocked.length,
      },
      getExecutionCtx(c),
      { env: c.env }
    );
    return c.json({
      approvedCount: approved.length,
      blockedCount: blocked.length,
      approved,
      blocked: blocked.map((b) => ({
        customerId: b.customerId,
        name: b.name,
        reasons: [...b.reasons],
      })),
    });
  });

  // Option B: Partner Referral & Monthly Residual Rev-Share Calculator (Effect)
  const partnerResidualsRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/partner-residuals",
    tags: ["customers"],
    middleware: [rls("customer:view", "workspace:read")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              merchants: z.array(
                z.object({
                  customerId: z.string(),
                  merchantName: z.string(),
                  partnerId: z.string(),
                  partnerName: z.string(),
                  monthlyCardVolumeCents: z.number().int().min(0),
                  monthlyAchCount: z.number().int().min(0),
                  netCardMarginBps: z.number().optional(),
                  netAchMarginCentsPerTx: z.number().optional(),
                  partnerRevSharePct: z.number().min(0).max(80).optional(),
                })
              ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Computed monthly partner residual revenue-share payouts across referred merchants using Effect",
        content: {
          "application/json": {
            schema: z.object({
              totalMerchants: z.number(),
              totalVortexNetProfitCents: z.number(),
              totalPartnerResidualPayoutCents: z.number(),
              rows: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
    },
  });

  app.openapi(partnerResidualsRoute, async (c) => {
    const input = c.req.valid("json");
    const { Effect } = await import("effect");
    const { computePartnerResidualsWithEffect } =
      await import("../agents/collectors-effect.js");
    const result = await Effect.runPromise(
      computePartnerResidualsWithEffect(input.merchants)
    );
    return c.json({
      totalMerchants: result.totalMerchants,
      totalVortexNetProfitCents: result.totalVortexNetProfitCents,
      totalPartnerResidualPayoutCents: result.totalPartnerResidualPayoutCents,
      rows: result.rows as unknown as Array<Record<string, unknown>>,
    });
  });

  // Option C: 80/20 Daily Auto-Replenish Runner (Effect)
  const autoReplenishRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/customers/auto-replenish",
    tags: ["customers"],
    middleware: [rls("customer:edit", "workspace:write")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              totalLeads: z.number().int().min(5).max(100).default(20),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Executed 80/20 Core Wedge vs Exploration auto-replenish across presets using Effect and bulk DO ingest",
        content: {
          "application/json": {
            schema: z.object({
              totalPulled: z.number(),
              totalCreated: z.number(),
              totalUpdated: z.number(),
              batches: z.array(
                z.object({
                  preset: z.string(),
                  bucket: z.string(),
                  ownerId: z.string(),
                  pulledCount: z.number(),
                  createdCount: z.number(),
                  updatedCount: z.number(),
                  nextOffset: z.number(),
                })
              ),
            }),
          },
        },
      },
    },
  });

  app.openapi(autoReplenishRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const { Effect } = await import("effect");
    const { planDaily8020Replenish, pullDaily8020BatchesWithEffect } =
      await import("../agents/collectors-effect.js");

    const plan = planDaily8020Replenish({ totalLeads: input.totalLeads });
    const offsetsByPreset: Record<string, number> = {};
    for (const item of plan) {
      const cursorRows = await stub.memoryRecall({
        entityType: "workspace",
        entityId: organizationId,
        kind: `lead_cursor:${item.preset}`,
        limit: 1,
      });
      const stored = Number(cursorRows[0]?.fact ?? 0);
      offsetsByPreset[item.preset] =
        Number.isFinite(stored) && stored >= 0 ? stored : 0;
    }

    const pulledBatches = await Effect.runPromise(
      pullDaily8020BatchesWithEffect(plan, offsetsByPreset)
    );

    let totalPulled = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    const batches: Array<{
      preset: string;
      bucket: string;
      ownerId: string;
      pulledCount: number;
      createdCount: number;
      updatedCount: number;
      nextOffset: number;
    }> = [];

    for (const b of pulledBatches) {
      const ingested = await stub.ingestPulledLeadsBatch({
        sourceName: b.sourceName,
        cursorKind: `lead_cursor:${b.item.preset}`,
        nextOffset: b.nextOffset,
        actorUserId: c.var.workspaceIdentity.id,
        defaultOwnerId: b.item.ownerId,
        dispatchDetectiveBatch: false,
        candidates: b.candidates,
      });
      totalPulled += ingested.pulledCount;
      totalCreated += ingested.createdCount;
      totalUpdated += ingested.updatedCount;
      batches.push({
        preset: b.item.preset,
        bucket: b.item.bucket,
        ownerId: b.item.ownerId,
        pulledCount: ingested.pulledCount,
        createdCount: ingested.createdCount,
        updatedCount: ingested.updatedCount,
        nextOffset: b.nextOffset,
      });
    }

    return c.json({
      totalPulled,
      totalCreated,
      totalUpdated,
      batches,
    });
  });
}
