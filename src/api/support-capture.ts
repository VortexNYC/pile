import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { supportTicketAttachments, supportTickets } from "../global/schema.js";
import {
  createCapturePublicKey,
  createCaptureSession,
  finalizeCaptureSession,
  findCapturePublicKeyByKey,
  getCaptureSession,
  listCapturePublicKeys,
  revokeCapturePublicKey,
  updateCaptureSessionMetadata,
  updateCaptureSessionStatus,
} from "../global/support-capture.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import { addTicketMessage, createTicket } from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const capturePublicKeySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  key: z.string(),
  allowedOrigins: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createPublicKeyBodySchema = z.object({
  name: z.string().min(1),
  allowedOrigins: z.array(z.string()).default([]),
});

const tokenResponseSchema = z.object({
  token: z.string(),
});

const uploadSessionBodySchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
  attachmentType: z
    .enum(["screenshot", "video", "debugger_json", "log", "network"])
    .default("screenshot"),
  contentType: z.string().optional(),
  fileName: z.string().optional(),
  visibility: z.enum(["public", "private"]).default("private"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  deviceInfo: z.record(z.string(), z.unknown()).optional(),
});

const uploadSessionResponseSchema = z.object({
  uploadUrl: z.string(),
  r2Key: z.string(),
  sessionId: z.string(),
});

const uploadResponseSchema = z.object({
  r2Key: z.string(),
});

const finalizeResponseSchema = z.object({
  ticketId: z.string(),
  shareUrl: z.string().optional(),
});

const metadataBodySchema = z.object({
  metadata: z.record(z.string(), z.unknown()),
});

const createPublicKeyRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/capture/public-keys",
  tags: ["support-capture"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createPublicKeyBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Public key created",
      content: {
        "application/json": { schema: capturePublicKeySchema },
      },
    },
  },
});

const listPublicKeysRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/capture/public-keys",
  tags: ["support-capture"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Public keys",
      content: {
        "application/json": {
          schema: z.object({ publicKeys: z.array(capturePublicKeySchema) }),
        },
      },
    },
  },
});

const revokePublicKeyRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/capture/public-keys/{keyId}",
  tags: ["support-capture"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), keyId: z.string() }),
  },
  responses: {
    200: {
      description: "Public key revoked",
      content: {
        "application/json": { schema: capturePublicKeySchema },
      },
    },
    404: {
      description: "Not found",
    },
  },
});

const tokenRoute = createRoute({
  method: "post",
  path: "/support/capture/token",
  tags: ["support-capture"],
  request: {
    headers: z.object({
      "x-vortex-capture-public-key": z.string(),
      origin: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Capture token",
      content: {
        "application/json": { schema: tokenResponseSchema },
      },
    },
    401: {
      description: "Invalid public key or origin",
    },
  },
});

const uploadSessionRoute = createRoute({
  method: "post",
  path: "/support/capture/upload-session",
  tags: ["support-capture"],
  request: {
    headers: z.object({
      "x-vortex-capture-token": z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: uploadSessionBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Upload session",
      content: {
        "application/json": { schema: uploadSessionResponseSchema },
      },
    },
    401: {
      description: "Invalid or expired token",
    },
  },
});

const uploadRoute = createRoute({
  method: "post",
  path: "/support/capture/upload/{sessionId}/{attachmentType}",
  tags: ["support-capture"],
  request: {
    params: z.object({
      sessionId: z.string(),
      attachmentType: z.enum([
        "screenshot",
        "video",
        "debugger_json",
        "log",
        "network",
      ]),
    }),
    headers: z.object({
      "x-vortex-capture-token": z.string(),
    }),
  },
  responses: {
    200: {
      description: "Upload complete",
      content: {
        "application/json": { schema: uploadResponseSchema },
      },
    },
    401: {
      description: "Invalid or expired session",
    },
  },
});

const finalizeRoute = createRoute({
  method: "post",
  path: "/support/capture/finalize",
  tags: ["support-capture"],
  request: {
    headers: z.object({
      "x-vortex-capture-token": z.string(),
    }),
  },
  responses: {
    200: {
      description: "Capture finalized",
      content: {
        "application/json": { schema: finalizeResponseSchema },
      },
    },
    401: {
      description: "Invalid or expired token",
    },
  },
});

const metadataRoute = createRoute({
  method: "post",
  path: "/support/capture/metadata",
  tags: ["support-capture"],
  request: {
    headers: z.object({
      "x-vortex-capture-token": z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: metadataBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Metadata updated",
    },
    401: {
      description: "Invalid or expired token",
    },
  },
});

const viewArtifactRoute = createRoute({
  method: "get",
  path: "/support/capture/artifacts",
  tags: ["support-capture"],
  request: {
    query: z.object({
      r2Key: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Artifact binary",
    },
    404: {
      description: "Artifact not found",
    },
  },
});

const shareTicketRoute = createRoute({
  method: "get",
  path: "/support/capture/public/{ticketId}",
  tags: ["support-capture"],
  request: {
    params: z.object({
      ticketId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Public capture share",
      content: {
        "application/json": {
          schema: z.object({
            ticketId: z.string(),
            title: z.string(),
            attachments: z.array(
              z.object({
                type: z.enum([
                  "screenshot",
                  "video",
                  "debugger_json",
                  "log",
                  "network",
                ]),
                contentType: z.string().optional(),
                url: z.string().optional(),
                size: z.number().optional(),
              })
            ),
          }),
        },
      },
    },
    404: {
      description: "Ticket not found",
    },
  },
});

function assertSessionActive(session: { status: string; expiresAt: string }) {
  if (
    session.status === "expired" ||
    new Date(session.expiresAt) < new Date()
  ) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Capture session expired",
    });
  }
}

function assertOriginAllowed(
  publicKey: { allowedOrigins: string[] },
  origin: string | undefined
) {
  if (publicKey.allowedOrigins.length === 0) return;
  if (!origin) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Origin is required",
    });
  }
  if (!publicKey.allowedOrigins.includes(origin)) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Origin not allowed",
    });
  }
}

function defaultContentTypeForAttachment(attachmentType: string): string {
  switch (attachmentType) {
    case "screenshot":
      return "image/png";
    case "video":
      return "video/webm";
    case "debugger_json":
    case "network":
      return "application/json";
    case "log":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function buildCaptureArtifactKey(
  organizationId: string,
  sessionId: string,
  { attachmentType }: { attachmentType: string }
) {
  return `${organizationId}/capture/${sessionId}/${attachmentType}`;
}

type CaptureUploadRecord = {
  attachmentType: string;
  contentType: unknown;
  fileName: unknown;
  r2Key: string;
  uploaded: boolean;
  size: unknown;
};

function uploadsFromSession(session: {
  metadata: Record<string, unknown>;
}): CaptureUploadRecord[] {
  const uploads = session.metadata.uploads;
  if (!Array.isArray(uploads)) return [];
  return uploads.filter(
    (u): u is Record<string, unknown> =>
      typeof u === "object" &&
      u !== null &&
      typeof u.attachmentType === "string"
  ) as CaptureUploadRecord[];
}

export function registerSupportCaptureRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createPublicKeyRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const publicKey = await createCapturePublicKey(db, organizationId, {
      name: body.name,
      allowedOrigins: body.allowedOrigins,
    });
    return c.json(publicKey, 201);
  });

  app.openapi(listPublicKeysRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const publicKeys = await listCapturePublicKeys(db, organizationId);
    return c.json({ publicKeys });
  });

  app.openapi(revokePublicKeyRoute, async (c) => {
    const { organizationId, keyId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const publicKey = await revokeCapturePublicKey(db, organizationId, keyId);
    return c.json(publicKey);
  });

  app.openapi(tokenRoute, async (c) => {
    const publicKeyValue = c.req.header("x-vortex-capture-public-key");
    const origin = c.req.header("origin") ?? c.req.header("Origin");
    if (!publicKeyValue) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-vortex-capture-public-key is required",
      });
    }

    const db = createD1(c.env.D1);
    const publicKey = await findCapturePublicKeyByKey(db, publicKeyValue);
    if (!publicKey) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid public key",
      });
    }

    assertOriginAllowed(publicKey, origin);

    const session = await createCaptureSession(
      db,
      publicKey.id,
      publicKey.organizationId
    );
    return c.json({ token: session.id });
  });

  app.openapi(uploadSessionRoute, async (c) => {
    const token = c.req.header("x-vortex-capture-token");
    if (!token) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-vortex-capture-token is required",
      });
    }

    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const session = await getCaptureSession(db, token);
    if (!session) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid capture token",
      });
    }
    assertSessionActive(session);

    await updateCaptureSessionStatus(db, session.id, "uploading");

    const attachmentType = body.attachmentType;
    const contentType =
      body.contentType ?? defaultContentTypeForAttachment(attachmentType);
    const r2Key = buildCaptureArtifactKey(session.organizationId, session.id, {
      attachmentType,
    });
    const uploadUrl = `/support/capture/upload/${session.id}/${attachmentType}`;

    const existingUploads = uploadsFromSession(session);
    const nextUploads = [
      ...existingUploads.filter((u) => u.attachmentType !== attachmentType),
      {
        attachmentType,
        contentType,
        fileName: body.fileName ?? null,
        r2Key,
        uploaded: false,
        size: null,
      },
    ];

    const { metadata: customMetadata, ...rest } = body;
    const merged: Record<string, unknown> = {
      ...session.metadata,
      ...rest,
      ...(customMetadata && typeof customMetadata === "object"
        ? customMetadata
        : {}),
      uploads: nextUploads,
    };
    await updateCaptureSessionMetadata(db, session.id, merged);

    return c.json({ uploadUrl, r2Key, sessionId: session.id });
  });

  app.openapi(uploadRoute, async (c) => {
    const { sessionId, attachmentType } = c.req.valid("param");
    const token = c.req.header("x-vortex-capture-token");
    if (token !== sessionId) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid capture token",
      });
    }

    const db = createD1(c.env.D1);
    const session = await getCaptureSession(db, sessionId);
    if (!session) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid capture session",
      });
    }
    assertSessionActive(session);

    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    }

    const contentType =
      c.req.header("content-type") ?? "application/octet-stream";
    const arrayBuffer = await c.req.arrayBuffer();
    const r2Key = buildCaptureArtifactKey(session.organizationId, session.id, {
      attachmentType,
    });
    await bucket.put(r2Key, new Blob([arrayBuffer], { type: contentType }));

    const existingUploads = uploadsFromSession(session);
    const nextUploads = existingUploads.map((u) =>
      u.attachmentType === attachmentType
        ? (Object.assign({}, u, {
            uploaded: true,
            contentType,
            size: arrayBuffer.byteLength,
          }) as CaptureUploadRecord)
        : u
    );
    await updateCaptureSessionMetadata(db, session.id, {
      ...session.metadata,
      uploads: nextUploads,
    });

    return c.json({ r2Key });
  });

  app.openapi(finalizeRoute, async (c) => {
    const token = c.req.header("x-vortex-capture-token");
    if (!token) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-vortex-capture-token is required",
      });
    }

    const db = createD1(c.env.D1);
    const session = await getCaptureSession(db, token);
    if (!session) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid capture token",
      });
    }
    assertSessionActive(session);

    const meta = session.metadata;
    const email = typeof meta.email === "string" ? meta.email : null;
    const fullName = typeof meta.fullName === "string" ? meta.fullName : null;
    const title = typeof meta.title === "string" ? meta.title : "Bug report";
    const description =
      typeof meta.description === "string" ? meta.description : "";
    const priority =
      meta.priority === "low" ||
      meta.priority === "medium" ||
      meta.priority === "high" ||
      meta.priority === "urgent"
        ? meta.priority
        : "medium";

    if (!email) {
      throw new VortexError({
        status: 400,
        code: "BAD_REQUEST",
        message: "Capture metadata must include email",
      });
    }

    const customer = await findOrCreateCustomerByEmail(
      db,
      session.organizationId,
      email,
      fullName,
      "capture"
    );

    const ticket = await createTicket(db, {
      organizationId: session.organizationId,
      customerId: customer.id,
      title,
      priority,
      sourceChannel: "capture",
    });

    const text = description || `Bug report from capture (${title})`;
    const markdown = description;
    const event = await addTicketMessage(
      db,
      session.organizationId,
      ticket.id,
      {
        direction: "inbound",
        textContent: text,
        markdownContent: markdown,
        channel: "capture",
        customerId: customer.id,
        actorType: "customer",
        actorId: customer.id,
      },
      c.env
    );

    const origin = new URL(c.req.url).origin;
    const uploads = uploadsFromSession(session).filter((u) => u.uploaded);

    await Promise.all(
      uploads.map((upload) => {
        const r2Key = typeof upload.r2Key === "string" ? upload.r2Key : "";
        const contentType =
          typeof upload.contentType === "string"
            ? upload.contentType
            : "application/octet-stream";
        const size = typeof upload.size === "number" ? upload.size : null;
        const url = r2Key
          ? `${origin}/support/capture/artifacts?r2Key=${encodeURIComponent(r2Key)}`
          : null;
        return db.insert(supportTicketAttachments).values({
          id: crypto.randomUUID(),
          organizationId: session.organizationId,
          ticketId: ticket.id,
          eventId: event.id,
          type: upload.attachmentType as
            | "screenshot"
            | "video"
            | "debugger_json"
            | "log"
            | "network",
          contentType,
          r2Key,
          size,
          url,
          fileName:
            typeof upload.fileName === "string" ? upload.fileName : null,
          createdAt: new Date().toISOString(),
        });
      })
    );

    await finalizeCaptureSession(db, session.id, {
      customerId: customer.id,
      ticketId: ticket.id,
      status: "finalized",
    });

    const shareUrl =
      meta.visibility === "public"
        ? `${origin}/support/capture/public/${ticket.id}`
        : undefined;

    return c.json({ ticketId: ticket.id, shareUrl });
  });

  app.openapi(metadataRoute, async (c) => {
    const token = c.req.header("x-vortex-capture-token");
    if (!token) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-vortex-capture-token is required",
      });
    }

    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const session = await getCaptureSession(db, token);
    if (!session) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid capture token",
      });
    }
    assertSessionActive(session);

    await updateCaptureSessionMetadata(db, session.id, body.metadata);
    return c.json({ ok: true });
  });

  app.openapi(viewArtifactRoute, async (c) => {
    const { r2Key } = c.req.valid("query");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    }

    const object = await bucket.get(r2Key);
    if (!object) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Artifact not found",
      });
    }

    const contentType =
      object.httpMetadata?.contentType ?? "application/octet-stream";
    if (!object.body) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Artifact not found",
      });
    }
    return c.body(object.body, 200, {
      "Content-Type": contentType,
    });
  });

  app.openapi(shareTicketRoute, async (c) => {
    const { ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    const [ticket] = await db
      .select({ id: supportTickets.id, title: supportTickets.title })
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    if (!ticket) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Ticket not found",
      });
    }

    const attachments = await db
      .select({
        type: supportTicketAttachments.type,
        contentType: supportTicketAttachments.contentType,
        url: supportTicketAttachments.url,
        size: supportTicketAttachments.size,
      })
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, ticketId));

    return c.json({
      ticketId: ticket.id,
      title: ticket.title,
      attachments: attachments.map((a) => ({
        type: a.type,
        contentType: a.contentType,
        url: a.url,
        size: a.size,
      })),
    });
  });
}
