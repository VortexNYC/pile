import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { supportTicketAttachments, supportTickets } from "../global/schema.js";
import {
  createCapturePublicKey,
  createCaptureSession,
  finalizeCaptureSession,
  getCapturePublicKeyById,
  findCapturePublicKeyByKey,
  getCaptureSession,
  listCapturePublicKeys,
  revokeCapturePublicKey,
  updateCaptureSessionMetadata,
  updateCaptureSessionStatus,
} from "../global/support-capture.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  getTicketById,
} from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const capturePublicKeySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  key: z.string(),
  webhookSecret: z.string().nullable(),
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
      "x-vortex-capture-reference": z.string().optional(),
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

const jamAuthorSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
});

const jamMediaSchema = z.object({
  videoUrl: z.string().optional(),
  screenshotUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
});

const jamRecordingLinkSchema = z.object({
  publicId: z.string().optional(),
  type: z.enum(["one_time", "reusable"]).optional(),
  recordingUrl: z.string().optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
  submitterComment: z.string().optional(),
});

const jamWebhookBodySchema = z.object({
  jamId: z.string(),
  jamUrl: z.string(),
  teamId: z.string(),
  type: z.enum(["video", "screenshot", "sessionReplay"]),
  createdAt: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  originalUrl: z.string().optional(),
  origin: z.string().optional(),
  author: jamAuthorSchema.default({}),
  media: jamMediaSchema.default({}),
  recordingLink: jamRecordingLinkSchema.optional(),
});

const jamWebhookRoute = createRoute({
  method: "post",
  path: "/support/webhooks/jam/{publicKeyId}",
  tags: ["support-capture"],
  request: {
    params: z.object({ publicKeyId: z.string() }),
    headers: z.object({
      "svix-id": z.string(),
      "svix-timestamp": z.string(),
      "svix-signature": z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: jamWebhookBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Jam captured",
      content: {
        "application/json": {
          schema: z.object({ ticketId: z.string() }),
        },
      },
    },
    401: {
      description: "Invalid webhook",
    },
    404: {
      description: "Public key or ticket not found",
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    c |= a[i] ^ b[i];
  }
  return c === 0;
}

async function verifySvixSignature({
  payload,
  svixId,
  svixTimestamp,
  svixSignature,
  secret,
}: {
  payload: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  secret: string;
}): Promise<boolean> {
  const rawSecret = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(rawSecret);
  } catch {
    return false;
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = `${svixId}.${svixTimestamp}.${payload}`;
  const signedBytes = new TextEncoder().encode(signed);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, signedBytes)
  );

  const versions = svixSignature
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice("v1,".length));

  for (const version of versions) {
    let provided: Uint8Array;
    try {
      provided = base64ToBytes(version);
    } catch {
      continue;
    }
    if (constantTimeEqual(expected, provided)) return true;
  }
  return false;
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

    const reference = c.req.header("x-vortex-capture-reference");
    const session = await createCaptureSession(
      db,
      publicKey.id,
      publicKey.organizationId,
      30,
      reference ? { reference } : {}
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

    const reference =
      typeof session.metadata.reference === "string"
        ? session.metadata.reference
        : null;

    let ticket:
      | Awaited<ReturnType<typeof getTicketById>>
      | Awaited<ReturnType<typeof createTicket>>
      | null = reference
      ? await getTicketById(db, session.organizationId, reference)
      : null;

    if (!ticket) {
      ticket = await createTicket(db, {
        organizationId: session.organizationId,
        customerId: customer.id,
        title,
        priority,
        sourceChannel: "capture",
      });
    }

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

  app.openapi(jamWebhookRoute, async (c) => {
    const { publicKeyId } = c.req.valid("param");
    const svixId = c.req.header("svix-id") ?? "";
    const svixTimestamp = c.req.header("svix-timestamp") ?? "";
    const svixSignature = c.req.header("svix-signature") ?? "";

    const db = createD1(c.env.D1);
    const publicKey = await getCapturePublicKeyById(db, publicKeyId);
    if (!publicKey || !publicKey.isActive || !publicKey.webhookSecret) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid Jam webhook key",
      });
    }

    const payload = await c.req.text();
    const verified = await verifySvixSignature({
      payload,
      svixId,
      svixTimestamp,
      svixSignature,
      secret: publicKey.webhookSecret,
    });
    if (!verified) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid Jam webhook signature",
      });
    }

    const parsed = jamWebhookBodySchema.parse(JSON.parse(payload));

    const reference = parsed.recordingLink?.reference;
    const email = parsed.author?.email;
    const fullName = parsed.author?.name ?? null;
    const customer = email
      ? await findOrCreateCustomerByEmail(
          db,
          publicKey.organizationId,
          email,
          fullName,
          "capture"
        )
      : null;

    let ticket = null;
    if (reference) {
      const existing = await getTicketById(
        db,
        publicKey.organizationId,
        reference
      );
      if (existing) ticket = existing;
    }

    if (!ticket) {
      if (!customer) {
        throw new VortexError({
          status: 400,
          code: "BAD_REQUEST",
          message:
            "Jam webhook must include an author email when creating a new ticket",
        });
      }
      ticket = await createTicket(db, {
        organizationId: publicKey.organizationId,
        customerId: customer.id,
        title: parsed.title ?? `Jam ${parsed.type} from ${parsed.jamUrl}`,
        priority: "medium",
        sourceChannel: "capture",
        externalSource: "jam",
        externalId: parsed.jamId,
      });
    }

    const text = [parsed.description, parsed.recordingLink?.submitterComment]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n\n");
    const customerId = customer?.id ?? ticket.customerId;

    const event = await addTicketMessage(
      db,
      publicKey.organizationId,
      ticket.id,
      {
        direction: "inbound",
        textContent: text || `Jam capture: ${parsed.jamUrl}`,
        markdownContent: text,
        channel: "capture",
        customerId,
        actorType: "customer",
        actorId: customerId,
      },
      c.env
    );

    const attachmentInputs: {
      type: "screenshot" | "video" | "debugger_json" | "log" | "network";
      url: string;
      contentType: string;
    }[] = [];

    if (parsed.type === "video" || parsed.type === "sessionReplay") {
      if (parsed.media.videoUrl) {
        attachmentInputs.push({
          type: "video",
          url: parsed.media.videoUrl,
          contentType: "video/mp4",
        });
      }
      if (parsed.media.thumbnailUrl) {
        attachmentInputs.push({
          type: "screenshot",
          url: parsed.media.thumbnailUrl,
          contentType: "image/jpeg",
        });
      }
    }
    if (parsed.type === "screenshot" && parsed.media.screenshotUrl) {
      attachmentInputs.push({
        type: "screenshot",
        url: parsed.media.screenshotUrl,
        contentType: "image/png",
      });
    }

    await Promise.all(
      attachmentInputs.map((input) =>
        db.insert(supportTicketAttachments).values({
          id: crypto.randomUUID(),
          organizationId: publicKey.organizationId,
          ticketId: ticket.id,
          eventId: event.id,
          type: input.type,
          contentType: input.contentType,
          url: input.url,
          r2Key: null,
          createdAt: new Date().toISOString(),
        })
      )
    );

    return c.json({ ticketId: ticket.id });
  });
}
