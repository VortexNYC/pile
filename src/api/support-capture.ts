import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { createD1, type D1Client } from "../global/db.js";
import { storeJamCaptureArtifacts } from "../global/jam-capture.js";
import {
  supportCaptureSessions,
  supportTicketAttachments,
  supportTickets,
} from "../global/schema.js";
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
  findSupportTicketByExternalId,
  getTicketById,
  type SupportTicketSource,
} from "../global/support-tickets.js";
import { enqueueWebhook, scopedDeliveryId } from "../global/webhook-queue.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import { toApiKeyWorkspaceIdentity } from "../platform/identity.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

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

const publicCapturePublicKeySchema = capturePublicKeySchema.omit({
  webhookSecret: true,
});

const createPublicKeyBodySchema = z.object({
  name: z.string().min(1),
  allowedOrigins: z.array(z.string()).default([]),
});

const tokenResponseSchema = z.object({
  token: z.string(),
  recordingUrl: z.string(),
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
  visibility: z.enum(["public", "private"]).optional(),
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
        "application/json": { schema: publicCapturePublicKeySchema },
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
          schema: z.object({
            publicKeys: z.array(publicCapturePublicKeySchema),
          }),
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
        "application/json": { schema: publicCapturePublicKeySchema },
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
      "x-pile-capture-public-key": z.string(),
      "x-pile-capture-reference": z.string().optional(),
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
      "x-pile-capture-token": z.string(),
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
  path: "/support/capture/upload/{sessionId}/{attachmentType}/{fileName}",
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
      fileName: z.string(),
    }),
    headers: z.object({
      "x-pile-capture-token": z.string(),
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
      "x-pile-capture-token": z.string(),
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
      "x-pile-capture-token": z.string(),
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
  path: "/support/capture/artifacts/{attachmentId}",
  tags: ["support-capture"],
  request: {
    params: z.object({
      attachmentId: z.string(),
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

const captureSessionRoute = createRoute({
  method: "get",
  path: "/support/capture/sessions/{sessionId}",
  tags: ["support-capture"],
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Capture recording session",
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string(),
            status: z.string(),
            expiresAt: z.string(),
            ticketId: z.string().nullable(),
            reference: z.string().nullable(),
            uploads: z.array(
              z.object({
                attachmentType: z.string(),
                contentType: z.string().nullable().optional(),
                r2Key: z.string(),
                uploaded: z.boolean(),
              })
            ),
          }),
        },
      },
    },
    404: {
      description: "Session not found",
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

const jamAuthorSchema = z
  .object({
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const jamMediaSchema = z
  .object({
    videoUrl: z.string().optional(),
    screenshotUrl: z.string().optional(),
    thumbnailUrl: z.string().optional(),
  })
  .passthrough();

const jamRecordingLinkSchema = z
  .object({
    publicId: z.string().optional(),
    type: z.enum(["one_time", "reusable"]).optional(),
    recordingUrl: z.string().optional(),
    description: z.string().optional(),
    reference: z.string().optional(),
    submitterComment: z.string().optional(),
  })
  .passthrough();

const jamProviderSchema = z
  .object({
    conversationId: z.string().optional(),
    issueId: z.string().optional(),
  })
  .passthrough();

const jamBrowserSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

const jamOsSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

const jamScreenSchema = z
  .object({
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

const jamBatterySchema = z
  .object({
    charging: z.boolean().optional(),
    level: z.number().optional(),
  })
  .passthrough();

const jamConnectionSchema = z
  .object({
    effectiveType: z.string().optional(),
    downlinkMbps: z.number().optional(),
    rttMs: z.number().optional(),
  })
  .passthrough();

const jamSystemInfoSchema = z
  .object({
    browser: jamBrowserSchema.optional(),
    os: jamOsSchema.optional(),
    screen: jamScreenSchema.optional(),
    battery: jamBatterySchema.optional(),
    connection: jamConnectionSchema.optional(),
  })
  .passthrough();

const jamConsoleLogSchema = z
  .object({
    level: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const jamNetworkRequestSchema = z
  .object({
    url: z.string().optional(),
    method: z.string().optional(),
    status: z.number().optional(),
    duration: z.number().optional(),
    requestHeaders: z.record(z.string(), z.string()).optional(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const jamUserEventSchema = z
  .object({
    type: z.string().optional(),
    timestamp: z.string().optional(),
    selector: z.string().optional(),
    target: z.string().optional(),
    value: z.string().optional(),
  })
  .passthrough();

const jamWebhookBodySchema = z
  .object({
    jamId: z.string(),
    jamUrl: z.string(),
    teamId: z.string(),
    type: z.enum(["video", "screenshot", "sessionReplay"]),
    createdAt: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    originalUrl: z.string().optional(),
    origin: z.string().optional(),
    isIncognito: z.boolean().optional(),
    author: jamAuthorSchema.default({}),
    media: jamMediaSchema.default({}),
    systemInfo: jamSystemInfoSchema.optional(),
    consoleLogs: z.array(jamConsoleLogSchema).optional(),
    networkRequests: z.array(jamNetworkRequestSchema).optional(),
    userEvents: z.array(jamUserEventSchema).optional(),
    recordingLink: jamRecordingLinkSchema.optional(),
    intercom: jamProviderSchema.optional(),
    linear: jamProviderSchema.optional(),
  })
  .passthrough();

const jamIntercomRecordedSchema = z
  .object({
    conversationId: z.string(),
    jamId: z.string(),
    jamUrl: z.string(),
  })
  .passthrough();

const jamRecordingLinkCreatedSchema = z
  .object({
    recordingLinkId: z.string(),
    publicId: z.string(),
    url: z.string(),
    teamId: z.string(),
    type: z.enum(["one_time", "reusable"]),
    createdAt: z.string(),
    origin: z.string().optional(),
    description: z.string().optional(),
    reference: z.string().optional(),
    recordingUrl: z.string().optional(),
    createdBy: z
      .object({
        email: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const jamIntercomOptedOutSchema = z
  .object({
    conversationId: z.string(),
  })
  .passthrough();

const jamIntercomRecordedRoute = createRoute({
  method: "post",
  path: "/support/webhooks/jam/{publicKeyId}/intercom/recorded",
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
        "application/json": { schema: jamIntercomRecordedSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Intercom recorder recorded",
      content: {
        "application/json": {
          schema: z.object({
            ticketId: z.string().nullable(),
            deliveryId: z.string().optional(),
          }),
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

const jamIntercomOptedOutRoute = createRoute({
  method: "post",
  path: "/support/webhooks/jam/{publicKeyId}/intercom/opted-out",
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
        "application/json": { schema: jamIntercomOptedOutSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Intercom recorder opted out",
      content: {
        "application/json": {
          schema: z.object({
            ticketId: z.string().nullable(),
            deliveryId: z.string().optional(),
          }),
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

const jamRecordingLinkCreatedRoute = createRoute({
  method: "post",
  path: "/support/webhooks/jam/{publicKeyId}/recording-links",
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
        "application/json": { schema: jamRecordingLinkCreatedSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Recording link created",
      content: {
        "application/json": {
          schema: z.object({
            ticketId: z.string().nullable(),
            deliveryId: z.string().optional(),
          }),
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
          schema: z.object({
            ticketId: z.string().nullable(),
            deliveryId: z.string().optional(),
          }),
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
    session.status === "finalized" ||
    new Date(session.expiresAt) < new Date()
  ) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Capture session is no longer active",
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
  { attachmentType, fileName }: { attachmentType: string; fileName?: string }
) {
  if (fileName && fileName.length > 0) {
    return `${organizationId}/capture/${sessionId}/${attachmentType}/${fileName}`;
  }
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

async function fetchArtifactJson(
  bucket: R2Bucket,
  r2Key: string
): Promise<unknown> {
  const object = await bucket.get(r2Key);
  if (!object || !object.body) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Artifact not found",
    });
  }
  const text = await object.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function findAttachmentFileName(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  fileName: string
): Promise<string> {
  const row = await db
    .select()
    .from(supportTicketAttachments)
    .where(
      and(
        eq(supportTicketAttachments.organizationId, organizationId),
        eq(supportTicketAttachments.ticketId, ticketId),
        eq(supportTicketAttachments.fileName, fileName)
      )
    )
    .get();
  if (!row?.r2Key) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: `${fileName} not found`,
    });
  }
  return row.r2Key;
}

async function getArtifactAccess(
  db: D1Client,
  attachmentId: string
): Promise<{
  organizationId: string;
  r2Key: string | null;
  isPublic: boolean;
} | null> {
  const [attachment] = await db
    .select()
    .from(supportTicketAttachments)
    .where(eq(supportTicketAttachments.id, attachmentId))
    .limit(1);
  if (!attachment) {
    return null;
  }

  const [session] = await db
    .select()
    .from(supportCaptureSessions)
    .where(eq(supportCaptureSessions.ticketId, attachment.ticketId))
    .limit(1);

  let isPublic = false;
  if (session) {
    const metadata = JSON.parse(session.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    isPublic = metadata.visibility === "public";
  }

  return {
    organizationId: attachment.organizationId,
    r2Key: attachment.r2Key,
    isPublic,
  };
}

async function requireArtifactAuthorization(
  c: Context<AppContext>,
  organizationId: string
): Promise<void> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  const auth = createAuth(c.env);
  let result: unknown;
  try {
    result = await auth.api.verifyApiKey({ body: { key: token } });
  } catch {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid or expired token",
    });
  }

  if (
    !result ||
    typeof result !== "object" ||
    !("valid" in result) ||
    !result.valid ||
    !("key" in result) ||
    !result.key
  ) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid or expired token",
    });
  }

  const identity = toApiKeyWorkspaceIdentity(result.key);
  if (identity.organizationId !== organizationId) {
    throw new VortexError({
      status: 403,
      code: "FORBIDDEN",
      message: "Token does not belong to this workspace",
    });
  }
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
    return c.json(publicCapturePublicKeySchema.parse(publicKey), 201);
  });

  app.openapi(listPublicKeysRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const publicKeys = await listCapturePublicKeys(db, organizationId);
    return c.json({
      publicKeys: publicKeys.map((pk) =>
        publicCapturePublicKeySchema.parse(pk)
      ),
    });
  });

  app.openapi(revokePublicKeyRoute, async (c) => {
    const { organizationId, keyId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const publicKey = await revokeCapturePublicKey(db, organizationId, keyId);
    return c.json(publicCapturePublicKeySchema.parse(publicKey));
  });

  app.openapi(tokenRoute, async (c) => {
    const publicKeyValue = c.req.header("x-pile-capture-public-key");
    const requestOrigin = c.req.header("origin") ?? c.req.header("Origin");
    if (!publicKeyValue) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-pile-capture-public-key is required",
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

    assertOriginAllowed(publicKey, requestOrigin);

    const reference = c.req.header("x-pile-capture-reference");
    const session = await createCaptureSession(
      db,
      publicKey.id,
      publicKey.organizationId,
      30,
      reference ? { reference } : {}
    );
    const origin = new URL(c.req.url).origin;
    const recordingUrl = `${origin}/support/capture/sessions/${session.id}`;
    return c.json({ token: session.id, recordingUrl });
  });

  app.openapi(uploadSessionRoute, async (c) => {
    const token = c.req.header("x-pile-capture-token");
    if (!token) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-pile-capture-token is required",
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
    const fileName =
      typeof body.fileName === "string" && body.fileName.length > 0
        ? body.fileName
        : attachmentType;
    const r2Key = buildCaptureArtifactKey(session.organizationId, session.id, {
      attachmentType,
      fileName,
    });
    const uploadUrl = `/support/capture/upload/${session.id}/${attachmentType}/${encodeURIComponent(fileName)}`;

    const existingUploads = uploadsFromSession(session);
    const nextUploads = [
      ...existingUploads.filter((u) => u.r2Key !== r2Key),
      {
        attachmentType,
        contentType,
        fileName,
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
    const { sessionId, attachmentType, fileName } = c.req.valid("param");
    const token = c.req.header("x-pile-capture-token");
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
      fileName,
    });
    await bucket.put(r2Key, new Blob([arrayBuffer], { type: contentType }), {
      httpMetadata: { contentType },
    });

    const existingUploads = uploadsFromSession(session);
    const nextUploads = existingUploads.map((u) =>
      u.r2Key === r2Key
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
    const token = c.req.header("x-pile-capture-token");
    if (!token) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-pile-capture-token is required",
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

    if (session.ticketId) {
      const existingTicket = await getTicketById(
        db,
        session.organizationId,
        session.ticketId
      );
      if (existingTicket) {
        const origin = new URL(c.req.url).origin;
        const meta = session.metadata;
        const shareUrl =
          meta.visibility === "public"
            ? `${origin}/support/capture/public/${existingTicket.id}`
            : undefined;
        return c.json({ ticketId: existingTicket.id, shareUrl });
      }
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

    let issueId: string | null = null;

    let ticket:
      | Awaited<ReturnType<typeof getTicketById>>
      | Awaited<ReturnType<typeof createTicket>>
      | null = reference
      ? await getTicketById(db, session.organizationId, reference)
      : null;

    if (!ticket && reference) {
      const stub = getWorkspaceStub(c.env, session.organizationId);
      await stub.setOrganizationId(session.organizationId);
      const issue = await stub.getIssue(reference);
      if (issue) {
        issueId = issue.id;
      }
    }

    if (!ticket) {
      ticket = await createTicket(db, {
        organizationId: session.organizationId,
        customerId: customer.id,
        title,
        priority,
        sourceChannel: "capture",
        issueId: issueId ?? undefined,
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
        const attachmentId = crypto.randomUUID();
        const url = r2Key
          ? `${origin}/support/capture/artifacts/${attachmentId}`
          : null;
        return db.insert(supportTicketAttachments).values({
          id: attachmentId,
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
    const token = c.req.header("x-pile-capture-token");
    if (!token) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-pile-capture-token is required",
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
    const { attachmentId } = c.req.valid("param");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    }

    const db = createD1(c.env.D1);
    const access = await getArtifactAccess(db, attachmentId);
    if (!access || !access.r2Key) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Artifact not found",
      });
    }

    if (!access.isPublic) {
      await requireArtifactAuthorization(c, access.organizationId);
    }

    const object = await bucket.get(access.r2Key);
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

  app.openapi(captureSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const session = await getCaptureSession(db, sessionId);
    if (!session) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Capture session not found",
      });
    }
    const reference =
      typeof session.metadata.reference === "string"
        ? session.metadata.reference
        : null;
    const uploads = uploadsFromSession(session);
    return c.json({
      sessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      ticketId: session.ticketId,
      reference,
      uploads: uploads.map((u) => ({
        attachmentType: u.attachmentType,
        contentType: u.contentType ?? null,
        r2Key: u.r2Key,
        uploaded: u.uploaded,
      })),
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

    const [session] = await db
      .select({ metadata: supportCaptureSessions.metadata })
      .from(supportCaptureSessions)
      .where(eq(supportCaptureSessions.ticketId, ticketId))
      .limit(1);
    const meta = session
      ? (JSON.parse(session.metadata ?? "{}") as Record<string, unknown>)
      : null;
    if (!session || meta?.visibility !== "public") {
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

    const timestamp = Number(svixTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(timestamp) || Math.abs(now - timestamp) > 300) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Jam webhook timestamp out of tolerance",
      });
    }

    const parsed = jamWebhookBodySchema.parse(JSON.parse(payload));
    const origin = new URL(c.req.url).origin;
    const { deliveryId, result } = await enqueueWebhook(
      db,
      c.env,
      {
        deliveryId: scopedDeliveryId("jam", publicKey.organizationId, svixId),
        source: "jam",
        event: "jam.created",
        payload: {
          publicKey: { ...publicKey, webhookSecret: null },
          origin,
          body: parsed,
        },
      },
      new Map([["jam", processJamCreatedWebhookPayload]])
    );

    return c.json({
      ticketId: ticketIdFromResult(result),
      deliveryId,
    });
  });

  app.openapi(jamIntercomRecordedRoute, async (c) => {
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

    const timestamp = Number(svixTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(timestamp) || Math.abs(now - timestamp) > 300) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Jam webhook timestamp out of tolerance",
      });
    }

    const parsed = jamIntercomRecordedSchema.parse(JSON.parse(payload));
    const origin = new URL(c.req.url).origin;
    const { deliveryId, result } = await enqueueWebhook(
      db,
      c.env,
      {
        deliveryId: scopedDeliveryId(
          "jam-intercom-recorded",
          publicKey.organizationId,
          svixId
        ),
        source: "jam-intercom-recorded",
        event: "intercom.recorder.recorded",
        payload: {
          publicKey: { ...publicKey, webhookSecret: null },
          origin,
          body: parsed,
        },
      },
      new Map([
        ["jam-intercom-recorded", processJamIntercomRecordedWebhookPayload],
      ])
    );

    return c.json({
      ticketId: ticketIdFromResult(result),
      deliveryId,
    });
  });

  app.openapi(jamIntercomOptedOutRoute, async (c) => {
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

    const timestamp = Number(svixTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(timestamp) || Math.abs(now - timestamp) > 300) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Jam webhook timestamp out of tolerance",
      });
    }

    const parsed = jamIntercomOptedOutSchema.parse(JSON.parse(payload));
    const origin = new URL(c.req.url).origin;
    const { deliveryId, result } = await enqueueWebhook(
      db,
      c.env,
      {
        deliveryId: scopedDeliveryId(
          "jam-intercom-opted-out",
          publicKey.organizationId,
          svixId
        ),
        source: "jam-intercom-opted-out",
        event: "intercom.recorder.opted_out",
        payload: {
          publicKey: { ...publicKey, webhookSecret: null },
          origin,
          body: parsed,
        },
      },
      new Map([
        ["jam-intercom-opted-out", processJamIntercomOptedOutWebhookPayload],
      ])
    );

    return c.json({
      ticketId: ticketIdFromResult(result),
      deliveryId,
    });
  });

  app.openapi(jamRecordingLinkCreatedRoute, async (c) => {
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

    const timestamp = Number(svixTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(timestamp) || Math.abs(now - timestamp) > 300) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Jam webhook timestamp out of tolerance",
      });
    }

    const parsed = jamRecordingLinkCreatedSchema.parse(JSON.parse(payload));
    const origin = new URL(c.req.url).origin;
    const { deliveryId, result } = await enqueueWebhook(
      db,
      c.env,
      {
        deliveryId: scopedDeliveryId(
          "jam-recording-link",
          publicKey.organizationId,
          svixId
        ),
        source: "jam-recording-link",
        event: "recording_link.created",
        payload: {
          publicKey: { ...publicKey, webhookSecret: null },
          origin,
          body: parsed,
        },
      },
      new Map([
        ["jam-recording-link", processJamRecordingLinkCreatedWebhookPayload],
      ])
    );

    return c.json({
      ticketId: ticketIdFromResult(result),
      deliveryId,
    });
  });

  const captureConsoleQuerySchema = z.object({
    level: z.string().optional(),
    isError: z.enum(["true", "false"]).optional(),
  });

  const captureConsoleRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/support/captures/{ticketId}/console",
    tags: ["support-capture"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        ticketId: z.string(),
      }),
      query: captureConsoleQuerySchema,
    },
    responses: {
      200: {
        description: "Console logs",
        content: {
          "application/json": {
            schema: z.object({ events: z.array(z.unknown()) }),
          },
        },
      },
      404: { description: "Console logs not found" },
    },
  });

  const captureNetworkQuerySchema = z.object({
    isError: z.enum(["true", "false"]).optional(),
    url: z.string().optional(),
  });

  const captureNetworkRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/support/captures/{ticketId}/network",
    tags: ["support-capture"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        ticketId: z.string(),
      }),
      query: captureNetworkQuerySchema,
    },
    responses: {
      200: {
        description: "Network requests",
        content: {
          "application/json": {
            schema: z.object({ events: z.array(z.unknown()) }),
          },
        },
      },
      404: { description: "Network requests not found" },
    },
  });

  const captureEventsQuerySchema = z.object({
    type: z.string().optional(),
    action: z.string().optional(),
  });

  const captureEventsRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/support/captures/{ticketId}/events",
    tags: ["support-capture"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        ticketId: z.string(),
      }),
      query: captureEventsQuerySchema,
    },
    responses: {
      200: {
        description: "User events",
        content: {
          "application/json": {
            schema: z.object({ events: z.array(z.unknown()) }),
          },
        },
      },
      404: { description: "User events not found" },
    },
  });

  const captureFramesRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/support/captures/{ticketId}/frames",
    tags: ["support-capture"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        ticketId: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Visual frames",
        content: {
          "application/json": {
            schema: z.object({
              frames: z.array(
                z.object({
                  url: z.string().nullable(),
                  type: z.string(),
                  fileName: z.string().nullable(),
                })
              ),
            }),
          },
        },
      },
      404: { description: "Frames not found" },
    },
  });

  const captureMetadataRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/support/captures/{ticketId}/metadata",
    tags: ["support-capture"],
    middleware: [rls("read")],
    request: {
      params: z.object({
        organizationId: z.string(),
        ticketId: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Capture metadata",
        content: {
          "application/json": {
            schema: z.object({
              deviceInfo: z.record(z.string(), z.unknown()).nullable(),
              metadata: z.record(z.string(), z.unknown()).nullable(),
              eventsSummary: z.record(z.string(), z.unknown()).nullable(),
              postprocessing: z.record(z.string(), z.unknown()).nullable(),
            }),
          },
        },
      },
      404: { description: "Capture not found" },
    },
  });

  app.openapi(captureConsoleRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const { level, isError } = c.req.valid("query");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket)
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    const db = createD1(c.env.D1);
    const r2Key = await findAttachmentFileName(
      db,
      organizationId,
      ticketId,
      "console-logs.json"
    );
    const raw = await fetchArtifactJson(bucket, r2Key);
    let events = Array.isArray(raw) ? raw : [];
    if (level) {
      events = events.filter((e) => isRecord(e) && e.console_level === level);
    }
    if (isError === "true") {
      events = events.filter((e) => isRecord(e) && e.is_error === true);
    }
    return c.json({ events });
  });

  app.openapi(captureNetworkRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const { isError, url } = c.req.valid("query");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket)
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    const db = createD1(c.env.D1);
    const r2Key = await findAttachmentFileName(
      db,
      organizationId,
      ticketId,
      "network-requests.json"
    );
    const raw = await fetchArtifactJson(bucket, r2Key);
    let events = Array.isArray(raw) ? raw : [];
    if (isError === "true") {
      events = events.filter((e) => isRecord(e) && e.is_error === true);
    }
    if (url) {
      events = events.filter(
        (e) =>
          isRecord(e) &&
          typeof e.network_url === "string" &&
          e.network_url.includes(url)
      );
    }
    return c.json({ events });
  });

  app.openapi(captureEventsRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const { type, action } = c.req.valid("query");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket)
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    const db = createD1(c.env.D1);
    const r2Key = await findAttachmentFileName(
      db,
      organizationId,
      ticketId,
      "user-events.json"
    );
    const raw = await fetchArtifactJson(bucket, r2Key);
    let events = Array.isArray(raw) ? raw : [];
    if (type) {
      events = events.filter((e) => isRecord(e) && e.event_type === type);
    }
    if (action) {
      events = events.filter(
        (e) => isRecord(e) && e.interactivity_action === action
      );
    }
    return c.json({ events });
  });

  app.openapi(captureFramesRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const frames = await db
      .select()
      .from(supportTicketAttachments)
      .where(
        and(
          eq(supportTicketAttachments.organizationId, organizationId),
          eq(supportTicketAttachments.ticketId, ticketId),
          eq(supportTicketAttachments.type, "screenshot")
        )
      )
      .all();
    const videos = await db
      .select()
      .from(supportTicketAttachments)
      .where(
        and(
          eq(supportTicketAttachments.organizationId, organizationId),
          eq(supportTicketAttachments.ticketId, ticketId),
          eq(supportTicketAttachments.type, "video")
        )
      )
      .all();
    return c.json({
      frames: [...frames, ...videos].map((row) => ({
        url: row.url,
        type: row.type,
        fileName: row.fileName,
      })),
    });
  });

  app.openapi(captureMetadataRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket)
      throw new VortexError({
        status: 500,
        code: "CONFIG_ERROR",
        message: "Attachments bucket not configured",
      });
    const db = createD1(c.env.D1);
    const rows = await db
      .select()
      .from(supportTicketAttachments)
      .where(
        and(
          eq(supportTicketAttachments.organizationId, organizationId),
          eq(supportTicketAttachments.ticketId, ticketId),
          eq(supportTicketAttachments.type, "debugger_json")
        )
      )
      .all();
    const output: {
      deviceInfo: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
      eventsSummary: Record<string, unknown> | null;
      postprocessing: Record<string, unknown> | null;
    } = {
      deviceInfo: null,
      metadata: null,
      eventsSummary: null,
      postprocessing: null,
    };
    const records = await Promise.all(
      rows.map(async (row) => {
        if (!row.r2Key) return null;
        const data = await fetchArtifactJson(bucket, row.r2Key);
        return { fileName: row.fileName, data: isRecord(data) ? data : null };
      })
    );
    for (const record of records) {
      if (!record || !record.data) continue;
      if (record.fileName === "device-info.json")
        output.deviceInfo = record.data;
      if (record.fileName === "metadata.json") output.metadata = record.data;
      if (record.fileName === "events-summary.json")
        output.eventsSummary = record.data;
      if (record.fileName === "postprocessing.json")
        output.postprocessing = record.data;
    }
    return c.json(output);
  });
}

function ticketIdFromResult(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  if ("ticketId" in result && typeof result.ticketId === "string") {
    return result.ticketId;
  }
  return null;
}

const jamQueuePayloadSchema = z.object({
  publicKey: capturePublicKeySchema,
  origin: z.string(),
  body: z.unknown(),
});

const jamIntercomQueuePayloadSchema = z.object({
  publicKey: capturePublicKeySchema,
  origin: z.string(),
  body: z.unknown(),
});

export async function processJamCreatedWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<Record<string, unknown>> {
  const { publicKey, origin, body } = jamQueuePayloadSchema.parse(payload);
  const organizationId = publicKey.organizationId;
  const parsed = jamWebhookBodySchema.parse(body);

  const reference = parsed.recordingLink?.reference;
  const email = parsed.author?.email;
  const fullName = parsed.author?.name ?? null;
  const customer = email
    ? await findOrCreateCustomerByEmail(
        db,
        organizationId,
        email,
        fullName,
        "capture"
      )
    : null;

  const intercomConversationId = parsed.intercom?.conversationId;
  const linearIssueId = parsed.linear?.issueId;

  const text = [parsed.description, parsed.recordingLink?.submitterComment]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");

  if (!reference && !intercomConversationId && !linearIssueId) {
    const existing = await db
      .select()
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.organizationId, organizationId),
          eq(supportTickets.externalSource, "jam"),
          eq(supportTickets.externalId, parsed.jamId)
        )
      )
      .get();
    if (existing) return { ticketId: existing.id };
  }

  let ticket:
    | Awaited<ReturnType<typeof getTicketById>>
    | Awaited<ReturnType<typeof findSupportTicketByExternalId>>
    | null = null;

  if (reference) {
    const existing = await getTicketById(db, organizationId, reference);
    if (existing) ticket = existing;
  }
  if (!ticket && intercomConversationId) {
    const existing = await findSupportTicketByExternalId(
      db,
      organizationId,
      intercomConversationId,
      "intercom"
    );
    if (existing) ticket = existing;
  }
  if (!ticket && linearIssueId) {
    const existing = await findSupportTicketByExternalId(
      db,
      organizationId,
      linearIssueId,
      "linear"
    );
    if (existing) ticket = existing;
  }

  if (!ticket) {
    if (!customer) {
      return { ticketId: null };
    }

    const externalSource: SupportTicketSource = intercomConversationId
      ? "intercom"
      : linearIssueId
        ? "linear"
        : "jam";
    let issueId: string | undefined;
    if (linearIssueId) {
      const stub = getWorkspaceStub(env, organizationId);
      await stub.setOrganizationId(organizationId);
      const issue = await stub.createIssue({
        title: parsed.title ?? `Jam ${parsed.type} from ${parsed.jamUrl}`,
        description: text,
        status: "backlog",
        priority: "medium",
      });
      issueId = issue.id;
    }

    ticket = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: parsed.title ?? `Jam ${parsed.type} from ${parsed.jamUrl}`,
      priority: "medium",
      sourceChannel: "capture",
      issueId,
      externalSource,
      externalId: intercomConversationId ?? linearIssueId ?? parsed.jamId,
      ifExists: "return",
    });
  }

  const customerId = customer?.id ?? ticket.customerId;

  const event = await addTicketMessage(db, organizationId, ticket.id, {
    direction: "inbound",
    textContent: text || `Jam capture: ${parsed.jamUrl}`,
    markdownContent: text,
    channel: "capture",
    customerId,
    actorType: "customer",
    actorId: customerId,
    subType: "jam_created",
    externalId: parsed.jamId,
  });

  const remoteAttachments: {
    type: "screenshot" | "video";
    url: string;
    contentType: string;
  }[] = [];
  if (parsed.type === "video" || parsed.type === "sessionReplay") {
    if (parsed.media.videoUrl) {
      remoteAttachments.push({
        type: "video",
        url: parsed.media.videoUrl,
        contentType: "video/mp4",
      });
    }
    if (parsed.media.thumbnailUrl) {
      remoteAttachments.push({
        type: "screenshot",
        url: parsed.media.thumbnailUrl,
        contentType: "image/jpeg",
      });
    }
  }
  if (parsed.type === "screenshot" && parsed.media.screenshotUrl) {
    remoteAttachments.push({
      type: "screenshot",
      url: parsed.media.screenshotUrl,
      contentType: "image/png",
    });
  }

  const inlineArtifacts: {
    type: "debugger_json" | "log" | "network";
    name: string;
    data: unknown;
  }[] = [];
  if (parsed.consoleLogs?.length) {
    inlineArtifacts.push({
      type: "log",
      name: "console-logs.json",
      data: parsed.consoleLogs,
    });
  }
  if (parsed.networkRequests?.length) {
    inlineArtifacts.push({
      type: "network",
      name: "network-requests.json",
      data: parsed.networkRequests,
    });
  }
  if (parsed.userEvents?.length) {
    inlineArtifacts.push({
      type: "log",
      name: "user-events.json",
      data: parsed.userEvents,
    });
  }
  if (
    parsed.systemInfo &&
    Object.keys(parsed.systemInfo).some(
      (k) =>
        parsed.systemInfo![k as keyof typeof parsed.systemInfo] !== undefined
    )
  ) {
    inlineArtifacts.push({
      type: "debugger_json",
      name: "device-info.json",
      data: parsed.systemInfo,
    });
  }

  await storeJamCaptureArtifacts(
    db,
    env,
    organizationId,
    origin,
    ticket.id,
    event.id,
    parsed.jamId,
    remoteAttachments,
    inlineArtifacts
  );

  return { ticketId: ticket.id };
}

export async function processJamIntercomRecordedWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<Record<string, unknown>> {
  const { publicKey, body } = jamIntercomQueuePayloadSchema.parse(payload);
  const parsed = jamIntercomRecordedSchema.parse(body);
  const organizationId = publicKey.organizationId;

  const ticket = await findSupportTicketByExternalId(
    db,
    organizationId,
    parsed.conversationId,
    "intercom"
  );
  if (!ticket) {
    return { ticketId: null };
  }

  const text = `Customer recorded a Jam: ${parsed.jamUrl}`;
  await addTicketMessage(db, organizationId, ticket.id, {
    direction: "inbound",
    textContent: text,
    markdownContent: text,
    channel: "intercom",
    customerId: ticket.customerId,
    actorType: "customer",
    actorId: ticket.customerId,
    subType: "intercom_recorder_recorded",
    externalId: `${parsed.conversationId}:${parsed.jamId}`,
    runAutoresponders: false,
    reopenOnCustomerReply: false,
  });

  return { ticketId: ticket.id };
}

export async function processJamIntercomOptedOutWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<Record<string, unknown>> {
  const { publicKey, body } = jamIntercomQueuePayloadSchema.parse(payload);
  const parsed = jamIntercomOptedOutSchema.parse(body);
  const organizationId = publicKey.organizationId;

  const ticket = await findSupportTicketByExternalId(
    db,
    organizationId,
    parsed.conversationId,
    "intercom"
  );
  if (!ticket) {
    return { ticketId: null };
  }

  await addTicketMessage(db, organizationId, ticket.id, {
    direction: "inbound",
    textContent: "Customer declined to record a Jam.",
    markdownContent: "Customer declined to record a Jam.",
    channel: "intercom",
    actorType: "automation",
    subType: "intercom_recorder_opted_out",
    externalId: `opted-out:${parsed.conversationId}`,
    runAutoresponders: false,
    reopenOnCustomerReply: false,
  });

  return { ticketId: ticket.id };
}

export async function processJamRecordingLinkCreatedWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<Record<string, unknown>> {
  const { publicKey, body } = jamIntercomQueuePayloadSchema.parse(payload);
  const parsed = jamRecordingLinkCreatedSchema.parse(body);
  const organizationId = publicKey.organizationId;

  if (!parsed.reference) {
    return { ticketId: null };
  }

  const ticket = await getTicketById(db, organizationId, parsed.reference);
  if (!ticket) {
    return { ticketId: null };
  }

  const text = `Recording link shared: ${parsed.url}`;
  await addTicketMessage(db, organizationId, ticket.id, {
    direction: "outbound",
    textContent: text,
    markdownContent: text,
    channel: "capture",
    actorType: "automation",
    subType: "recording_link_created",
    externalId: parsed.recordingLinkId,
    runAutoresponders: false,
    reopenOnCustomerReply: false,
  });

  return { ticketId: ticket.id };
}
