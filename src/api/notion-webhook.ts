import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1, type D1Client } from "../global/db.js";
import { getNotionPage } from "../global/notion-client.js";
import type { NotionSearchPage } from "../global/notion-client.js";
import {
  findNotionInstallation,
  updateNotionInstallationVerificationToken,
} from "../global/notion-installations.js";
import { findNotionPageMapping } from "../global/notion-page-mappings.js";
import {
  enqueueWebhook,
  scopedDeliveryId,
  type WebhookProcessor,
  type WebhookSource,
} from "../global/webhook-queue.js";
import { getWorkspaceById } from "../global/workspaces.js";
import { syncNotionPage } from "../import/notion.js";
import type { ImportContext } from "../import/types.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { getWorkspaceStub } from "./stub.js";

const notionWebhookParamsSchema = z.object({
  organizationId: z.string(),
  workspaceId: z.string(),
});

const notionVerificationHandshakeSchema = z.object({
  verification_token: z.string(),
});

const notionWebhookEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  workspace_id: z.string(),
  type: z.string(),
  entity: z.object({
    id: z.string(),
    type: z.string(),
  }),
  data: z.unknown().optional(),
});

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyNotionSignature(
  rawBody: string,
  signature: string,
  verificationToken: string
): Promise<boolean> {
  const expected = `sha256=${await hmacSha256Hex(verificationToken, rawBody)}`;
  return constantTimeCompare(signature, expected);
}

const notionQueuePayloadSchema = z.object({
  organizationId: z.string(),
  workspaceId: z.string(),
  event: notionWebhookEventSchema,
});

export async function processNotionWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<{ ok: true }> {
  const data = notionQueuePayloadSchema.parse(payload);
  const { organizationId, workspaceId, event } = data;

  const installation = await findNotionInstallation(
    db,
    organizationId,
    workspaceId
  );
  if (!installation) {
    return { ok: true };
  }

  const workspace = await getWorkspaceById(db, organizationId);
  if (!workspace) {
    return { ok: true };
  }

  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const ctx: ImportContext = {
    env,
    requestHeaders: new Headers(),
    organizationId,
    importerId: workspace.ownerId,
    jobId: "notion-webhook",
    db,
    stub,
  };

  if (event.entity.type === "page") {
    if (event.type === "page.deleted") {
      const mapping = await findNotionPageMapping(
        db,
        organizationId,
        event.entity.id
      );
      if (mapping) {
        await stub.updateDocument(
          mapping.documentId,
          { trashedAt: new Date().toISOString() },
          workspace.ownerId
        );
      }
      return { ok: true };
    }

    if (
      [
        "page.created",
        "page.content_updated",
        "page.properties_updated",
        "page.moved",
      ].includes(event.type)
    ) {
      const page = await getNotionPage(installation.token, event.entity.id);
      let parentDocumentId: string | null = null;
      if (page.parentPageId) {
        const parentMapping = await findNotionPageMapping(
          db,
          organizationId,
          page.parentPageId
        );
        parentDocumentId = parentMapping?.documentId ?? null;
      }
      const searchPage: NotionSearchPage = {
        id: page.id,
        url: page.url,
        icon: page.icon,
        title: page.title,
        parentType: page.parentType,
        parentPageId: page.parentPageId,
      };
      await syncNotionPage(
        ctx,
        installation.token,
        searchPage,
        null,
        parentDocumentId
      );
      return { ok: true };
    }
  }

  return { ok: true };
}

const notionWebhookRoute = createRoute({
  method: "post",
  path: "/notion/{organizationId}/{workspaceId}",
  tags: ["notion"],
  request: {
    params: notionWebhookParamsSchema,
  },
  responses: {
    200: {
      description: "Webhook processed",
    },
    400: {
      description: "Bad request",
    },
    401: {
      description: "Invalid signature",
    },
    404: {
      description: "Notion installation not found",
    },
  },
});

export function registerNotionWebhookRoute(app: OpenAPIHono<AppContext>) {
  app.openapi(notionWebhookRoute, async (c) => {
    const { organizationId, workspaceId } = c.req.valid("param");
    const rawBody = await c.req.text();
    const signature = c.req.header("X-Notion-Signature");

    const db = createD1(c.env.D1);
    const installation = await findNotionInstallation(
      db,
      organizationId,
      workspaceId
    );
    if (!installation) {
      return c.json({ error: "Notion installation not found" }, 404);
    }

    if (!signature) {
      const parsed = JSON.parse(rawBody);
      const handshake = notionVerificationHandshakeSchema.safeParse(parsed);
      if (!handshake.success) {
        return c.json({ error: "Invalid handshake" }, 400);
      }
      await updateNotionInstallationVerificationToken(
        db,
        installation.id,
        handshake.data.verification_token
      );
      return c.json({ ok: true });
    }

    if (!installation.verificationToken) {
      return c.json({ error: "Verification token not configured" }, 401);
    }

    const valid = await verifyNotionSignature(
      rawBody,
      signature,
      installation.verificationToken
    );
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const event = notionWebhookEventSchema.parse(JSON.parse(rawBody));
    if (event.workspace_id !== workspaceId) {
      return c.json({ error: "Workspace mismatch" }, 400);
    }

    const workspace = await getWorkspaceById(db, organizationId);
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const deliveryId = scopedDeliveryId("notion", organizationId, event.id);
    const processors = new Map<WebhookSource, WebhookProcessor>([
      ["notion", processNotionWebhookPayload],
    ]);

    await enqueueWebhook(
      db,
      c.env,
      {
        deliveryId,
        source: "notion",
        event: event.type,
        organizationId,
        payload: { organizationId, workspaceId, event },
      },
      processors
    );

    return c.json({ ok: true });
  });
}
