import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import captureSdkBundle from "../assets/capture.iife.js";
import { transcribeCaptureRecording } from "../global/capture-transcript.js";
import { createD1, type D1Client } from "../global/db.js";
import { storeJamCaptureArtifacts } from "../global/jam-capture.js";
import {
  SCRUBBABLE_ATTACHMENT_TYPES,
  scrubCaptureText,
} from "../global/redact.js";
import {
  supportCaptureSessions,
  supportTicketAttachments,
  supportTickets,
  user,
} from "../global/schema.js";
import {
  countCaptureLinkSessions,
  createCaptureLink,
  createCapturePublicKey,
  createCaptureSession,
  finalizeCaptureSession,
  findCaptureLinkByToken,
  getCapturePublicKeyById,
  findCapturePublicKeyByKey,
  getCaptureSession,
  listCaptureLinks,
  listCapturePublicKeys,
  revokeCaptureLink,
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
import { publicRateLimit } from "../platform/rate-limit.js";
import { rls } from "../platform/rls.js";
import { renderCaptureLinkPage } from "./capture-link-page.js";
import { getExecutionCtx } from "./execution-ctx.js";
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

const captureArtifactKindSchema = z.enum([
  "screenshot",
  "video",
  "debugger_json",
  "log",
  "network",
  "replay",
  "transcript",
]);

type CaptureArtifactKind = z.infer<typeof captureArtifactKindSchema>;

const uploadSessionBodySchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
  attachmentType: captureArtifactKindSchema.default("screenshot"),
  contentType: z.string().optional(),
  fileName: z.string().optional(),
  artifacts: z
    .array(
      z.object({
        attachmentType: captureArtifactKindSchema,
        fileName: z.string().optional(),
        contentType: z.string().optional(),
      })
    )
    .optional(),
  visibility: z.enum(["public", "private"]).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  deviceInfo: z.record(z.string(), z.unknown()).optional(),
  // PILE-665 — when true the server mints an R2 multipart upload for the
  // declared video artifact so the client can stream MediaRecorder chunks
  // while recording instead of buffering the whole video.
  multipart: z.boolean().optional(),
  // PILE-675 — rrweb DOM replay events, persisted as a replay.json artifact
  // rather than in the session metadata column (the array is large).
  replayEvents: z.array(z.unknown()).max(50_000).optional(),
  // PILE-675 — opt-in flag telling ingest to keep bounded network
  // request/response bodies on network entries.
  includeNetworkBodies: z.boolean().optional(),
});

const uploadSessionResponseSchema = z.object({
  uploadUrl: z.string(),
  r2Key: z.string(),
  sessionId: z.string(),
  // PILE-665 — present when a multipart upload was minted for the session.
  uploadId: z.string().optional(),
  partUploadUrl: z.string().optional(),
  // PILE-665 — public share link is known before recording finishes.
  shareUrl: z.string().optional(),
  uploads: z
    .array(
      z.object({
        uploadUrl: z.string(),
        r2Key: z.string(),
        attachmentType: captureArtifactKindSchema,
        fileName: z.string(),
      })
    )
    .optional(),
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
  middleware: [rls("ticket:create")],
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
  middleware: [rls("ticket:view")],
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
  middleware: [rls("ticket:delete")],
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

const captureLinkSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  publicKeyId: z.string(),
  token: z.string(),
  name: z.string(),
  url: z.string(),
  expiresAt: z.string().nullable(),
  maxSessions: z.number().nullable(),
  requireChallenge: z.boolean(),
  isActive: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCaptureLinkBodySchema = z.object({
  publicKeyId: z.string().min(1),
  name: z.string().min(1).default("Capture link"),
  expiresAt: z.string().nullable().optional(),
  maxSessions: z.number().int().positive().nullable().optional(),
  // Defaults on for human actors (dashboard users sharing links with
  // customers), off for agent actors — a challenge would block automation.
  requireChallenge: z.boolean().optional(),
});

const createCaptureLinkRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/capture-links",
  tags: ["support-capture"],
  middleware: [rls("ticket:create")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createCaptureLinkBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Capture link created",
      content: {
        "application/json": { schema: captureLinkSchema },
      },
    },
  },
});

const listCaptureLinksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/capture-links",
  tags: ["support-capture"],
  middleware: [rls("ticket:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Capture links",
      content: {
        "application/json": {
          schema: z.object({
            links: z.array(captureLinkSchema),
          }),
        },
      },
    },
  },
});

const revokeCaptureLinkRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/capture-links/{linkId}",
  tags: ["support-capture"],
  middleware: [rls("ticket:delete")],
  request: {
    params: z.object({ organizationId: z.string(), linkId: z.string() }),
  },
  responses: {
    200: {
      description: "Capture link revoked",
      content: {
        "application/json": { schema: captureLinkSchema },
      },
    },
    404: {
      description: "Not found",
    },
  },
});

const feedbackTimestampSchema = z.string().max(60).optional();

const memberFeedbackBodySchema = z.object({
  kind: z.enum(["bug", "feature", "other"]),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(8000),
  url: z.string().max(2048).optional(),
  userAgent: z.string().max(500).optional(),
  viewport: z
    .object({
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
    })
    .optional(),
  deviceInfo: z.record(z.string(), z.unknown()).optional(),
  // Legacy error-only buffer from the first bubble iteration — still
  // accepted so older sessions can file. New clients send consoleLogs
  // (all levels) plus a separate errors array.
  consoleErrors: z
    .array(
      z.object({
        level: z.string().min(1).max(20),
        message: z.string().min(1).max(4000),
        timestamp: feedbackTimestampSchema,
      })
    )
    .max(100)
    .optional(),
  consoleLogs: z
    .array(
      z.object({
        level: z.string().min(1).max(20),
        message: z.string().min(1).max(4000),
        timestamp: feedbackTimestampSchema,
      })
    )
    .max(500)
    .optional(),
  networkRequests: z
    .array(
      z.object({
        method: z.string().min(1).max(16),
        url: z.string().min(1).max(2048),
        status: z.number().int().min(0).max(999).optional(),
        duration: z.number().nonnegative().max(3_600_000).optional(),
        timestamp: feedbackTimestampSchema,
        // PILE-675 — only persisted when includeNetworkBodies is true, and
        // always bounded + credential-scrubbed server-side.
        requestBody: z.string().max(65_536).optional(),
        responseBody: z.string().max(65_536).optional(),
      })
    )
    .max(400)
    .optional(),
  userEvents: z
    .array(
      z.object({
        type: z.string().min(1).max(40),
        target: z.string().max(500).optional(),
        timestamp: feedbackTimestampSchema,
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .max(100)
    .optional(),
  errors: z
    .array(
      z.object({
        message: z.string().min(1).max(4000),
        stack: z.string().max(8000).optional(),
        source: z.string().max(60).optional(),
        timestamp: feedbackTimestampSchema,
      })
    )
    .max(100)
    .optional(),
  screenshotDataUrl: z.string().max(10_000_000).optional(),
  recordingDataUrl: z.string().max(40_000_000).optional(),
  // PILE-675 — rrweb DOM replay events persisted as a replay.json artifact.
  replayEvents: z.array(z.unknown()).max(50_000).optional(),
  // PILE-675 — opt-in to keep bounded request/response bodies on network
  // entries in the generated artifacts.
  includeNetworkBodies: z.boolean().optional(),
});

const memberFeedbackRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/feedback",
  tags: ["support-capture"],
  middleware: [rls("ticket:create")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: memberFeedbackBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Member feedback filed as a support ticket",
      content: {
        "application/json": {
          schema: z.object({
            ticketId: z.string(),
            ticketNumber: z.number(),
          }),
        },
      },
    },
    400: { description: "Invalid screenshot payload" },
  },
});

const tokenRoute = createRoute({
  security: [],
  method: "post",
  path: "/support/capture/token",
  tags: ["support-capture"],
  middleware: [publicRateLimit({ bucket: "capture-token", max: 30 })],
  request: {
    headers: z.object({
      "x-pile-capture-public-key": z.string().optional(),
      "x-pile-capture-link": z.string().optional(),
      "x-pile-capture-reference": z.string().optional(),
      origin: z.string().optional(),
    }),
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({ turnstileToken: z.string().optional() }),
        },
      },
    },
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
    403: {
      description: "CAPTURE_CHALLENGE_REQUIRED — a Turnstile token is needed",
    },
  },
});

async function verifyTurnstile(
  secretKey: string,
  token: string,
  remoteIp: string | undefined
): Promise<boolean> {
  const form = new URLSearchParams({
    secret: secretKey,
    response: token,
    ...(remoteIp ? { remoteip: remoteIp } : {}),
  });
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  );
  if (!res.ok) {
    return false;
  }
  const payload = (await res.json()) as { success?: boolean };
  return payload.success === true;
}

const uploadSessionRoute = createRoute({
  security: [],
  method: "post",
  path: "/support/capture/upload-session",
  tags: ["support-capture"],
  middleware: [publicRateLimit({ bucket: "capture-upload-session", max: 30 })],
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
  security: [],
  method: "post",
  path: "/support/capture/upload/{sessionId}/{attachmentType}/{fileName}",
  tags: ["support-capture"],
  middleware: [publicRateLimit({ bucket: "capture-upload", max: 120 })],
  request: {
    params: z.object({
      sessionId: z.string(),
      attachmentType: captureArtifactKindSchema,
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
  security: [],
  method: "post",
  path: "/support/capture/finalize",
  tags: ["support-capture"],
  middleware: [publicRateLimit({ bucket: "capture-finalize", max: 30 })],
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
  security: [],
  method: "post",
  path: "/support/capture/metadata",
  tags: ["support-capture"],
  middleware: [publicRateLimit({ bucket: "capture-metadata", max: 60 })],
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
  security: [],
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
  security: [],
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
            // PILE-669 — share-link engagement surfaced to agents/console.
            viewCount: z.number(),
            lastViewedAt: z.string().nullable(),
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

const shareAttachmentSchema = z.object({
  type: z.enum([
    "screenshot",
    "video",
    "debugger_json",
    "log",
    "network",
    "replay",
    "transcript",
  ]),
  fileName: z.string().nullable().optional(),
  contentType: z.string().optional(),
  url: z.string().optional(),
  size: z.number().optional(),
});

const shareTicketRoute = createRoute({
  security: [],
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
            // PILE-669 — how often the share link was opened and when last.
            viewCount: z.number(),
            lastViewedAt: z.string().nullable(),
            attachments: z.array(shareAttachmentSchema),
          }),
        },
      },
    },
    404: {
      description: "Ticket not found",
    },
  },
});

const sessionShareRoute = createRoute({
  security: [],
  method: "get",
  path: "/support/capture/share/{sessionId}",
  tags: ["support-capture"],
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description:
        "Public capture share (session-scoped, available before finalize)",
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string(),
            status: z.string(),
            ticketId: z.string().nullable(),
            title: z.string().nullable(),
            viewCount: z.number(),
            lastViewedAt: z.string().nullable(),
            attachments: z.array(shareAttachmentSchema),
          }),
        },
      },
    },
    404: {
      description: "Capture session not found",
    },
  },
});

const uploadPartQuerySchema = z.object({
  partNumber: z.coerce.number().int().min(1).max(10_000),
  uploadId: z.string().min(1),
});

const uploadPartResponseSchema = z.object({
  ok: z.boolean(),
  partNumber: z.number(),
  etag: z.string(),
});

const uploadPartRouteSpec = {
  security: [],
  path: "/support/capture/sessions/{sessionId}/upload/part",
  tags: ["support-capture"],
  middleware: [publicRateLimit({ bucket: "capture-upload-part", max: 600 })],
  request: {
    params: z.object({ sessionId: z.string() }),
    query: uploadPartQuerySchema,
    headers: z.object({
      "x-pile-capture-token": z.string(),
    }),
  },
  responses: {
    200: {
      description: "Multipart part uploaded",
      content: {
        "application/json": { schema: uploadPartResponseSchema },
      },
    },
    400: {
      description: "No active multipart upload for this session",
    },
    401: {
      description: "Invalid or expired session",
    },
  },
};

const uploadPartPutRoute = createRoute({
  method: "put",
  ...uploadPartRouteSpec,
});

const uploadPartPostRoute = createRoute({
  method: "post",
  ...uploadPartRouteSpec,
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
  security: [],
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
  security: [],
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
  security: [],
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
  security: [],
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
    case "replay":
      return "text/html";
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

const SCREENSHOT_DATA_URL =
  /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/;
const RECORDING_DATA_URL =
  /^data:(video\/(?:webm|mp4));base64,([A-Za-z0-9+/=\s]+)$/;

function decodeMediaDataUrl(
  dataUrl: string,
  pattern: RegExp,
  field: string
): { contentType: string; body: Uint8Array } {
  const match = pattern.exec(dataUrl);
  if (!match) {
    throw new VortexError({
      status: 400,
      code: "BAD_REQUEST",
      message: `${field} must be a base64 media data URL`,
    });
  }
  return {
    contentType: match[1]!,
    body: base64ToBytes(match[2]!.replace(/\s/g, "")),
  };
}

/** Reporter address for the ticket customer — the member's real email
 *  when their identity resolves to a user row, else a deterministic
 *  non-routable local part so agent-key actors still land on a stable
 *  customer record. */
export function feedbackReporterEmail(
  identity: { id: string; type: string },
  userEmail: string | null | undefined
): string {
  if (userEmail) return userEmail.toLowerCase().trim();
  const local = `${identity.type}-${identity.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${local || "unknown"}@feedback.pile.internal`;
}

function jsonArtifactBytes(data: unknown): Uint8Array {
  return new TextEncoder().encode(scrubCaptureText(JSON.stringify(data)));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
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
  let keyBytes: Uint8Array<ArrayBuffer>;
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

/** Transcription is post-landing enrichment — it must never block or fail
 *  the request that created the ticket. Deferred with `waitUntil` when an
 *  ExecutionContext exists; awaited inline otherwise (direct app.fetch in
 *  tests). `transcribeCaptureRecording` itself never rejects. */
async function kickCaptureTranscription(
  c: Context<AppContext>,
  work: Promise<unknown>
): Promise<void> {
  const execCtx = getExecutionCtx(c);
  if (execCtx) {
    execCtx.waitUntil(work);
    return;
  }
  await work;
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

  const auth = await createAuth(c.env);
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

const linkToResponse = (
  link: Awaited<ReturnType<typeof createCaptureLink>>,
  origin: string
) => ({ ...link, url: `${origin}/cap/${link.token}` });

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// PILE-675 — bounded network body retention: bodies only persist when the
// submission opted in, capped at 16KB and scrubbed by the artifact writer.
const MAX_NETWORK_BODY_CHARS = 16 * 1024;

function boundNetworkBody(value: string | undefined | null): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const bounded =
    value.length > MAX_NETWORK_BODY_CHARS
      ? value.slice(0, MAX_NETWORK_BODY_CHARS)
      : value;
  // Scrub the raw body before it gets embedded — once the artifact is
  // serialized the escapes hide the secrets from the whole-text pass.
  return scrubCaptureText(bounded);
}

/** PILE-665 — one streamed recording part: PUT/POST /upload/part. */
async function streamUploadPart(
  c: Context<AppContext>,
  {
    sessionId,
    partNumber,
    uploadId,
  }: { sessionId: string; partNumber: number; uploadId: string }
): Promise<{ ok: boolean; partNumber: number; etag: string }> {
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

  const meta = session.metadata;
  const objectKey =
    typeof meta.multipartObjectKey === "string"
      ? meta.multipartObjectKey
      : null;
  if (
    typeof meta.multipartUploadId !== "string" ||
    meta.multipartUploadId !== uploadId ||
    !objectKey ||
    meta.multipartCompleted === true
  ) {
    throw new VortexError({
      status: 400,
      code: "BAD_REQUEST",
      message: "Multipart upload is not active for this session",
    });
  }

  const body = await c.req.arrayBuffer();
  const uploadedPart = await bucket
    .resumeMultipartUpload(objectKey, uploadId)
    .uploadPart(partNumber, body);

  // Parts arrive sequentially from the recorder, but a retried part number
  // replaces its earlier record instead of duplicating it.
  const existing = Array.isArray(meta.multipartParts)
    ? meta.multipartParts
    : [];
  const parts = [
    ...existing.filter(
      (part) => !(isRecord(part) && part.partNumber === partNumber)
    ),
    {
      partNumber,
      etag: uploadedPart.etag,
      sizeBytes: body.byteLength,
    },
  ];
  await updateCaptureSessionMetadata(db, session.id, {
    multipartParts: parts,
  });

  return { ok: true, partNumber, etag: uploadedPart.etag };
}

/**
 * PILE-665 — a recording streamed via /upload/part lands as an open R2
 * multipart upload. Completing it materializes the object so the artifact
 * registration in finalize sees it like any other upload. Idempotent via
 * the multipartCompleted flag.
 */
async function completeStreamedCaptureUpload(
  bucket: R2Bucket | undefined,
  db: D1Client,
  session: { id: string; metadata: Record<string, unknown> }
): Promise<void> {
  if (!bucket) return;
  const meta = session.metadata;
  const uploadId =
    typeof meta.multipartUploadId === "string" ? meta.multipartUploadId : null;
  const objectKey =
    typeof meta.multipartObjectKey === "string"
      ? meta.multipartObjectKey
      : null;
  if (!uploadId || !objectKey || meta.multipartCompleted === true) return;

  const rawParts = Array.isArray(meta.multipartParts)
    ? meta.multipartParts
    : [];
  const parts = rawParts
    .filter(
      (part): part is { partNumber: number; etag: string } =>
        isRecord(part) &&
        typeof part.partNumber === "number" &&
        typeof part.etag === "string"
    )
    .toSorted((a, b) => a.partNumber - b.partNumber);
  if (parts.length === 0) return;

  await bucket.resumeMultipartUpload(objectKey, uploadId).complete(parts);
  await updateCaptureSessionMetadata(db, session.id, {
    multipartCompleted: true,
  });
}

/** PILE-669 — bump the view counters stored on the capture session. */
async function recordShareView(
  db: D1Client,
  sessionId: string,
  meta: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const viewCount = typeof meta.viewCount === "number" ? meta.viewCount : 0;
  const updated = await updateCaptureSessionMetadata(db, sessionId, {
    viewCount: viewCount + 1,
    lastViewedAt: new Date().toISOString(),
  });
  return updated.metadata;
}

type ShareAttachmentRow = {
  type: string;
  fileName: string | null;
  contentType: string | null;
  url: string | null;
  size: number | null;
  r2Key: string | null;
};

type TranscriptSegment = { start: number; end: number; text: string };

async function loadShareTranscript(
  bucket: R2Bucket | undefined,
  attachments: ShareAttachmentRow[]
): Promise<{ text: string | null; segments: TranscriptSegment[] }> {
  const row = attachments.find((a) => a.fileName === "transcript.json");
  if (!bucket || !row?.r2Key) return { text: null, segments: [] };
  try {
    const object = await bucket.get(row.r2Key);
    if (!object) return { text: null, segments: [] };
    const data = (await object.json()) as Record<string, unknown>;
    const text = typeof data.text === "string" ? data.text : null;
    const rawSegments = Array.isArray(data.segments) ? data.segments : [];
    const segments = rawSegments
      .filter(
        (segment): segment is TranscriptSegment =>
          isRecord(segment) &&
          typeof segment.start === "number" &&
          typeof segment.end === "number" &&
          typeof segment.text === "string" &&
          segment.text.trim().length > 0
      )
      .slice(0, 500);
    return { text, segments };
  } catch {
    return { text: null, segments: [] };
  }
}

/** PILE-668 — error/network counts for the device-info sidebar, read from
 *  the uploaded debugger.json when one exists. */
async function loadShareEventStats(
  bucket: R2Bucket | undefined,
  attachments: ShareAttachmentRow[]
): Promise<{ errors: number | null; networkRequests: number | null }> {
  const row = attachments.find(
    (a) => a.fileName === "debugger.json" && a.type === "debugger_json"
  );
  if (!bucket || !row?.r2Key) {
    return { errors: null, networkRequests: null };
  }
  try {
    const object = await bucket.get(row.r2Key);
    if (!object) return { errors: null, networkRequests: null };
    const data = (await object.json()) as Record<string, unknown>;
    const count = (key: string) =>
      Array.isArray(data[key]) ? (data[key] as unknown[]).length : null;
    const errorLogs = Array.isArray(data.logs)
      ? data.logs.filter((entry) => isRecord(entry) && entry.level === "error")
          .length
      : 0;
    const errors = count("errors");
    return {
      errors: errors === null ? null : errors + errorLogs,
      networkRequests: count("networkRequests"),
    };
  } catch {
    return { errors: null, networkRequests: null };
  }
}

function formatSegmentTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0
    ? `${h}:${String(mm).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * PILE-668 — the public watch page: Cap/Loom-style layout with the
 * recording front and center, clickable VTT captions, a transcript panel
 * whose timestamps seek the video, and a device/session sidebar.
 * Self-contained — no external assets, works on any modern browser.
 */
function renderShareWatchPage(opts: {
  title: string;
  videoUrl: string | null;
  videoContentType: string | null;
  vttUrl: string | null;
  screenshotUrls: string[];
  replayUrl: string | null;
  transcriptText: string | null;
  transcriptSegments: TranscriptSegment[];
  infoRows: { label: string; value: string }[];
  artifactLinks: { label: string; url: string }[];
  pending: boolean;
}): string {
  const title = escapeHtml(opts.title);

  const player = opts.videoUrl
    ? `<video id="capture-video" controls preload="metadata" src="${escapeHtml(
        opts.videoUrl
      )}"${
        opts.videoContentType
          ? ` type="${escapeHtml(opts.videoContentType)}"`
          : ""
      }>${
        opts.vttUrl
          ? `<track kind="captions" src="${escapeHtml(
              opts.vttUrl
            )}" srclang="en" label="English" default>`
          : ""
      }</video>`
    : opts.pending
      ? `<div class="pending">The recording is still being processed — refresh in a moment.</div>`
      : "";

  const screenshots = opts.screenshotUrls
    .map(
      (url) =>
        `<img class="screenshot" src="${escapeHtml(
          url
        )}" alt="Captured screenshot">`
    )
    .join("");

  const segments = opts.transcriptSegments
    .map(
      (segment) =>
        `<button type="button" class="seg" data-seek="${segment.start}">` +
        `<span class="seg-ts">${formatSegmentTimestamp(segment.start)}</span>` +
        `<span class="seg-text">${escapeHtml(segment.text.trim())}</span>` +
        `</button>`
    )
    .join("");
  const transcript =
    segments.length > 0
      ? `<section class="transcript"><h2>Transcript</h2><div class="segs">${segments}</div></section>`
      : opts.transcriptText
        ? `<section class="transcript"><h2>Transcript</h2><p class="transcript-plain">${escapeHtml(
            opts.transcriptText
          )}</p></section>`
        : "";

  const info = opts.infoRows
    .map(
      (row) =>
        `<div class="info-row"><dt>${escapeHtml(row.label)}</dt>` +
        `<dd>${escapeHtml(row.value)}</dd></div>`
    )
    .join("");

  const links = opts.artifactLinks
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.url)}">${escapeHtml(
          link.label
        )}</a></li>`
    )
    .join("");
  const artifactsBlock = links
    ? `<div class="info-block"><h2>Attachments</h2><ul class="links">${links}</ul></div>`
    : "";

  const replayBlock = opts.replayUrl
    ? `<p class="replay"><a href="${escapeHtml(
        opts.replayUrl
      )}">Watch DOM session replay</a></p>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#0a0a0a;color:#eee;min-height:100vh}
  .wrap{max-width:1120px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:20px;font-weight:600;margin:0 0 4px}
  .sub{color:#888;font-size:13px;margin-bottom:24px}
  .layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
  @media (max-width:880px){.layout{grid-template-columns:1fr}}
  video#capture-video{width:100%;max-height:70vh;border-radius:10px;background:#000;display:block}
  .pending{border:1px dashed #333;border-radius:10px;padding:48px 24px;text-align:center;color:#888}
  img.screenshot{max-width:100%;border-radius:10px;margin-top:16px}
  .transcript{margin-top:24px}
  .transcript h2,.sidebar h2,.info-block h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:0 0 10px}
  .segs{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto;border:1px solid #222;border-radius:8px;padding:6px}
  .seg{display:flex;gap:10px;align-items:baseline;text-align:left;background:none;border:0;color:#ddd;font:inherit;font-size:13px;padding:6px 8px;border-radius:6px;cursor:pointer}
  .seg:hover{background:#1a1a1a}
  .seg-ts{color:#7ee787;font-variant-numeric:tabular-nums;flex:none;font-size:12px}
  .transcript-plain{color:#ccc;font-size:14px;line-height:1.6;white-space:pre-wrap}
  .sidebar{border:1px solid #222;border-radius:10px;padding:16px;background:#111}
  .info-row{margin-bottom:10px}
  .info-row dt{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#777;margin-bottom:2px}
  .info-row dd{margin:0;font-size:13px;color:#ddd;word-break:break-word}
  .links{list-style:none;margin:0;padding:0}
  .links li{margin:6px 0}
  .links a,.replay a{color:#7ee787;font-size:13px}
  .info-block{margin-top:18px}
</style></head><body><div class="wrap">
<h1>${title}</h1>
<div class="sub">Shared capture</div>
<div class="layout">
<div class="main">${player}${screenshots}${replayBlock}${transcript}</div>
<aside class="sidebar"><h2>Device &amp; Session Info</h2><dl>${info}</dl>${artifactsBlock}</aside>
</div>
</div>
<script>
document.addEventListener("click",function(e){
  var t=e.target&&e.target.closest?e.target.closest("[data-seek]"):null;
  if(!t)return;
  var v=document.getElementById("capture-video");
  if(!v)return;
  var s=parseFloat(t.getAttribute("data-seek")||"0");
  if(isNaN(s))return;
  v.currentTime=s;
  v.play();
});
</script>
</body></html>`;
}

/**
 * PILE-668 — assembles the watch page from a session's metadata and the
 * ticket's attachment rows: video + VTT track + transcript segments +
 * device/session sidebar rows. Reporter-identifying fields (email,
 * fullName) are deliberately excluded from the public page.
 */
async function buildShareWatchPageHtml(
  bucket: R2Bucket | undefined,
  opts: {
    title: string;
    meta: Record<string, unknown>;
    sessionCreatedAt: string;
    viewCount: number;
    lastViewedAt: string | null;
    attachments: ShareAttachmentRow[];
    pending: boolean;
  }
): Promise<string> {
  const { attachments, meta } = opts;
  const video = attachments.find((a) => a.type === "video" && a.url);
  const vtt = attachments.find(
    (a) => a.type === "transcript" && a.fileName === "transcript.vtt" && a.url
  );
  const replay = attachments.find((a) => a.type === "replay" && a.url);
  const screenshotUrls = attachments
    .filter((a) => a.type === "screenshot" && a.url)
    .map((a) => a.url as string);

  const [{ text: transcriptText, segments }, stats] = await Promise.all([
    loadShareTranscript(bucket, attachments),
    loadShareEventStats(bucket, attachments),
  ]);

  const infoRows: { label: string; value: string }[] = [];
  const url = typeof meta.url === "string" ? meta.url : null;
  if (url) infoRows.push({ label: "Page", value: url });

  const deviceInfo = isRecord(meta.deviceInfo) ? meta.deviceInfo : null;
  const userAgent =
    typeof deviceInfo?.userAgent === "string"
      ? deviceInfo.userAgent
      : typeof meta.userAgent === "string"
        ? meta.userAgent
        : null;
  if (userAgent) infoRows.push({ label: "Browser / OS", value: userAgent });

  const viewport = isRecord(deviceInfo?.viewport)
    ? deviceInfo.viewport
    : isRecord(meta.viewport)
      ? meta.viewport
      : null;
  if (
    viewport &&
    typeof viewport.width === "number" &&
    typeof viewport.height === "number"
  ) {
    infoRows.push({
      label: "Viewport",
      value: `${viewport.width} × ${viewport.height}`,
    });
  }

  infoRows.push({ label: "Recorded", value: opts.sessionCreatedAt });
  infoRows.push({ label: "Views", value: String(opts.viewCount) });
  if (opts.lastViewedAt) {
    infoRows.push({ label: "Last viewed", value: opts.lastViewedAt });
  }
  if (stats.errors !== null) {
    infoRows.push({ label: "Errors", value: String(stats.errors) });
  }
  if (stats.networkRequests !== null) {
    infoRows.push({
      label: "Network requests",
      value: String(stats.networkRequests),
    });
  }

  const artifactLinks = attachments
    .filter(
      (a) =>
        a.url &&
        a.type !== "video" &&
        a.type !== "screenshot" &&
        !(a.type === "transcript" && a.fileName === "transcript.vtt")
    )
    .map((a) => ({ label: a.fileName ?? a.type, url: a.url as string }));

  return renderShareWatchPage({
    title: opts.title,
    videoUrl: video?.url ?? null,
    videoContentType: video?.contentType ?? null,
    vttUrl: vtt?.url ?? null,
    screenshotUrls,
    replayUrl: replay?.url ?? null,
    transcriptText,
    transcriptSegments: segments,
    infoRows,
    artifactLinks,
    pending: opts.pending,
  });
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

  app.openapi(createCaptureLinkRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const publicKey = await getCapturePublicKeyById(db, body.publicKeyId);
    if (!publicKey || publicKey.organizationId !== organizationId) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Capture public key not found",
      });
    }
    const identity = c.get("workspaceIdentity");
    const link = await createCaptureLink(db, organizationId, {
      publicKeyId: body.publicKeyId,
      name: body.name,
      expiresAt: body.expiresAt ?? null,
      maxSessions: body.maxSessions ?? null,
      requireChallenge: body.requireChallenge ?? identity?.type !== "agent",
      createdBy: identity?.id ?? null,
    });
    const origin = new URL(c.req.url).origin;
    return c.json(captureLinkSchema.parse(linkToResponse(link, origin)), 201);
  });

  app.openapi(listCaptureLinksRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const links = await listCaptureLinks(db, organizationId);
    const origin = new URL(c.req.url).origin;
    return c.json({
      links: links.map((link) =>
        captureLinkSchema.parse(linkToResponse(link, origin))
      ),
    });
  });

  app.openapi(revokeCaptureLinkRoute, async (c) => {
    const { organizationId, linkId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const link = await revokeCaptureLink(db, organizationId, linkId);
    const origin = new URL(c.req.url).origin;
    return c.json(captureLinkSchema.parse(linkToResponse(link, origin)));
  });

  // Jam-style in-app feedback: an authenticated member files a bug /
  // feature request straight into the workspace's tickets. One shot —
  // no public key, token, or upload session — but the context (device
  // info, console errors, screenshot) still lands as standard capture
  // artifacts so the captures viewers read it like any other capture.
  app.openapi(memberFeedbackRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);

    let screenshot: {
      contentType: string;
      fileName: string;
      body: Uint8Array;
    } | null = null;
    if (input.screenshotDataUrl) {
      const decoded = decodeMediaDataUrl(
        input.screenshotDataUrl,
        SCREENSHOT_DATA_URL,
        "screenshotDataUrl"
      );
      const extension =
        decoded.contentType === "image/png"
          ? "png"
          : decoded.contentType === "image/webp"
            ? "webp"
            : "jpg";
      screenshot = { ...decoded, fileName: `screenshot.${extension}` };
    }

    let recording: {
      contentType: string;
      fileName: string;
      body: Uint8Array;
    } | null = null;
    if (input.recordingDataUrl) {
      const decoded = decodeMediaDataUrl(
        input.recordingDataUrl,
        RECORDING_DATA_URL,
        "recordingDataUrl"
      );
      const extension = decoded.contentType === "video/mp4" ? "mp4" : "webm";
      recording = { ...decoded, fileName: `recording.${extension}` };
    }

    const reporter = await db
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, identity.id))
      .get();
    const email = feedbackReporterEmail(identity, reporter?.email);
    const fullName = reporter?.name ?? null;

    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      email,
      fullName,
      "capture"
    );

    const ticket = await createTicket(
      db,
      {
        organizationId,
        customerId: customer.id,
        title: `[feedback:${input.kind}] ${input.title}`,
        priority: "medium",
        sourceChannel: "capture",
        externalSource: "api",
      },
      c.env
    );

    const submittedAt = new Date().toISOString();
    const contextLines = [
      `kind: ${input.kind}`,
      `url: ${input.url ?? "unknown"}`,
      `user-agent: ${input.userAgent ?? "unknown"}`,
      input.viewport
        ? `viewport: ${input.viewport.width}x${input.viewport.height}`
        : null,
      `reporter: ${fullName ?? "member"} <${email}> (${identity.id})`,
      `console-logs: ${(input.consoleLogs?.length ?? 0) + (input.consoleErrors?.length ?? 0)}`,
      `network-requests: ${input.networkRequests?.length ?? 0}`,
      `user-events: ${input.userEvents?.length ?? 0}`,
      `errors: ${input.errors?.length ?? 0}`,
      `replay-events: ${input.replayEvents?.length ?? 0}`,
      `recording: ${recording ? "attached" : "none"}`,
    ].filter((line): line is string => line !== null);

    const event = await addTicketMessage(
      db,
      organizationId,
      ticket.id,
      {
        direction: "inbound",
        textContent: `${input.description}\n\n--- context ---\n${contextLines.join("\n")}`,
        markdownContent: input.description,
        channel: "capture",
        userId: identity.type === "user" ? identity.id : null,
        actorType: identity.type === "user" ? "user" : "agent",
        actorId: identity.id,
        subType: "member-feedback",
        metadata: {
          kind: input.kind,
          reportedByUserId: identity.id,
          reportedByEmail: email,
          url: input.url ?? null,
        },
      },
      c.env
    );

    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (bucket) {
      // Jam-parity artifact bundle — the same file names and field
      // shapes the capture viewers (/console, /network, /events,
      // /frames, /metadata) and agent tooling read off every other
      // capture ticket.
      const consoleLogs = [
        ...(input.consoleErrors ?? []),
        ...(input.consoleLogs ?? []),
      ].map((entry) => ({
        console_level: entry.level,
        console_value: entry.message,
        is_error: entry.level === "error",
        timestamp: entry.timestamp ?? submittedAt,
      }));
      for (const error of input.errors ?? []) {
        consoleLogs.push({
          console_level: "error",
          console_value: error.stack
            ? `${error.message}\n${error.stack}`
            : error.message,
          is_error: true,
          timestamp: error.timestamp ?? submittedAt,
        });
      }

      // PILE-675 — request/response bodies persist only when the
      // submission opted in, bounded to 16KB and scrubbed on write.
      const includeBodies = input.includeNetworkBodies === true;
      const networkRequests = (input.networkRequests ?? []).map((request) => {
        const entry: Record<string, unknown> = {
          network_url: request.url,
          network_method: request.method,
          network_status: request.status ?? null,
          duration_ms: request.duration ?? null,
          is_error:
            request.status === undefined
              ? false
              : request.status === 0 || request.status >= 400,
          timestamp: request.timestamp ?? submittedAt,
        };
        if (includeBodies) {
          entry.request_body = boundNetworkBody(request.requestBody);
          entry.response_body = boundNetworkBody(request.responseBody);
        }
        return entry;
      });

      const userEvents = (input.userEvents ?? []).map((userEvent) => ({
        event_type: "interactivity",
        interactivity_action: userEvent.type,
        target: userEvent.target ?? null,
        timestamp: userEvent.timestamp ?? submittedAt,
        ...(userEvent.metadata ? { metadata: userEvent.metadata } : {}),
      }));

      const artifacts: {
        type: CaptureArtifactKind;
        fileName: string;
        contentType: string;
        body: Uint8Array;
      }[] = [
        {
          type: "debugger_json",
          fileName: "metadata.json",
          contentType: "application/json",
          body: jsonArtifactBytes({
            source: "member-feedback",
            kind: input.kind,
            title: input.title,
            url: input.url ?? null,
            reporter: { userId: identity.id, email, name: fullName },
            workspace: organizationId,
            consoleLogs: consoleLogs.length,
            networkRequests: networkRequests.length,
            userEvents: userEvents.length,
            errors: input.errors?.length ?? 0,
            submittedAt,
          }),
        },
        {
          type: "debugger_json",
          fileName: "events-summary.json",
          contentType: "application/json",
          body: jsonArtifactBytes({
            consoleLogs: consoleLogs.length,
            networkRequests: networkRequests.length,
            userEvents: userEvents.length,
            errors: input.errors?.length ?? 0,
            screenshot: screenshot !== null,
            recording: recording !== null,
          }),
        },
      ];

      const deviceInfo = {
        ...input.deviceInfo,
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        ...(input.viewport ? { viewport: input.viewport } : {}),
      };
      if (Object.keys(deviceInfo).length > 0) {
        artifacts.push({
          type: "debugger_json",
          fileName: "device-info.json",
          contentType: "application/json",
          body: jsonArtifactBytes(deviceInfo),
        });
      }

      if (consoleLogs.length > 0) {
        artifacts.push({
          type: "log",
          fileName: "console-logs.json",
          contentType: "application/json",
          body: jsonArtifactBytes(consoleLogs),
        });
      }

      if (networkRequests.length > 0) {
        artifacts.push({
          type: "network",
          fileName: "network-requests.json",
          contentType: "application/json",
          body: jsonArtifactBytes(networkRequests),
        });
      }

      if (userEvents.length > 0) {
        artifacts.push({
          type: "log",
          fileName: "user-events.json",
          contentType: "application/json",
          body: jsonArtifactBytes(userEvents),
        });
      }

      // Agent-facing bundle — the debugger.json agents are pointed at
      // first when triaging a capture ticket.
      if (
        consoleLogs.length > 0 ||
        networkRequests.length > 0 ||
        userEvents.length > 0 ||
        (input.errors?.length ?? 0) > 0
      ) {
        artifacts.push({
          type: "debugger_json",
          fileName: "debugger.json",
          contentType: "application/json",
          body: jsonArtifactBytes({
            actions: (input.userEvents ?? []).map((userEvent) => ({
              type: userEvent.type,
              target: userEvent.target ?? null,
              timestamp: userEvent.timestamp ?? submittedAt,
              metadata: userEvent.metadata ?? null,
            })),
            logs: consoleLogs,
            networkRequests: (input.networkRequests ?? []).map((request) => {
              const entry: Record<string, unknown> = {
                method: request.method,
                url: request.url,
                status: request.status ?? null,
                duration: request.duration ?? null,
                timestamp: request.timestamp ?? submittedAt,
              };
              if (includeBodies) {
                entry.requestBody = boundNetworkBody(request.requestBody);
                entry.responseBody = boundNetworkBody(request.responseBody);
              }
              return entry;
            }),
            errors: (input.errors ?? []).map((error) => ({
              message: error.message,
              stack: error.stack ?? null,
              source: error.source ?? null,
              timestamp: error.timestamp ?? submittedAt,
            })),
          }),
        });
      }

      if (screenshot) {
        artifacts.push({
          type: "screenshot",
          fileName: screenshot.fileName,
          contentType: screenshot.contentType,
          body: screenshot.body,
        });
      }

      if (recording) {
        artifacts.push({
          type: "video",
          fileName: recording.fileName,
          contentType: recording.contentType,
          body: recording.body,
        });
      }

      // PILE-675 — raw rrweb DOM replay events for deterministic replay.
      if (input.replayEvents && input.replayEvents.length > 0) {
        artifacts.push({
          type: "replay",
          fileName: "replay.json",
          contentType: "application/json",
          body: jsonArtifactBytes(input.replayEvents),
        });
      }

      const origin = new URL(c.req.url).origin;
      await Promise.all(
        artifacts.map(async (artifact) => {
          const r2Key = `${organizationId}/capture/feedback-${ticket.id}/${artifact.type}/${artifact.fileName}`;
          await bucket.put(
            r2Key,
            new Blob([artifact.body as BlobPart], {
              type: artifact.contentType,
            }),
            { httpMetadata: { contentType: artifact.contentType } }
          );
          const attachmentId = crypto.randomUUID();
          await db.insert(supportTicketAttachments).values({
            id: attachmentId,
            organizationId,
            ticketId: ticket.id,
            eventId: event.id,
            type: artifact.type,
            contentType: artifact.contentType,
            r2Key,
            size: artifact.body.byteLength,
            url: `${origin}/support/capture/artifacts/${attachmentId}`,
            fileName: artifact.fileName,
            createdAt: submittedAt,
          });
        })
      );
    }

    // PILE-664 — feedback recordings get the same transcript treatment as
    // capture sessions. Member-authored titles stay as filed.
    if (bucket && recording) {
      await kickCaptureTranscription(
        c,
        transcribeCaptureRecording(db, c.env, {
          organizationId,
          ticketId: ticket.id,
          eventId: event.id,
          recordingR2Key: `${organizationId}/capture/feedback-${ticket.id}/video/${recording.fileName}`,
          artifactPrefix: `${organizationId}/capture/feedback-${ticket.id}`,
          origin,
        })
      );
    }

    return c.json({ ticketId: ticket.id, ticketNumber: ticket.number }, 201);
  });

  app.openapi(tokenRoute, async (c) => {
    const publicKeyValue = c.req.header("x-pile-capture-public-key");
    const linkTokenValue = c.req.header("x-pile-capture-link");
    const requestOrigin = c.req.header("origin") ?? c.req.header("Origin");
    if (!publicKeyValue && !linkTokenValue) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "x-pile-capture-public-key or x-pile-capture-link is required",
      });
    }

    const db = createD1(c.env.D1);
    const reference = c.req.header("x-pile-capture-reference");

    // Recording-link path: the link token stands in for a public key but
    // carries its own constraints — expiry, session cap, optional Turnstile —
    // and stamps the session with link attribution + public visibility so the
    // recorder (and the team) get a watchable share URL back.
    if (linkTokenValue) {
      const link = await findCaptureLinkByToken(db, linkTokenValue);
      if (
        !link ||
        (link.expiresAt !== null && link.expiresAt <= new Date().toISOString())
      ) {
        throw new VortexError({
          status: 401,
          code: "UNAUTHORIZED",
          message: "Invalid or expired capture link",
        });
      }
      if (link.maxSessions !== null) {
        const used = await countCaptureLinkSessions(db, link.id);
        if (used >= link.maxSessions) {
          throw new VortexError({
            status: 429,
            code: "RATE_LIMITED",
            message: "Capture link session limit reached",
          });
        }
      }
      if (link.requireChallenge && c.env.TURNSTILE_SECRET_KEY) {
        const rawBody = await c.req.json().catch(() => null);
        const turnstileToken =
          isRecord(rawBody) && typeof rawBody.turnstileToken === "string"
            ? rawBody.turnstileToken
            : undefined;
        const turnstileOk = turnstileToken
          ? await verifyTurnstile(
              c.env.TURNSTILE_SECRET_KEY,
              turnstileToken,
              c.req.header("cf-connecting-ip")
            )
          : false;
        if (!turnstileOk) {
          throw new VortexError({
            status: 403,
            code: "CAPTURE_CHALLENGE_REQUIRED",
            message: "A Turnstile challenge token is required",
            details: { siteKey: c.env.TURNSTILE_SITE_KEY ?? null },
          });
        }
      }
      const session = await createCaptureSession(
        db,
        link.publicKeyId,
        link.organizationId,
        30,
        {
          source: "capture-link",
          linkId: link.id,
          linkName: link.name,
          visibility: "public",
          ...(reference ? { reference } : {}),
        },
        link.id
      );
      const origin = new URL(c.req.url).origin;
      const recordingUrl = `${origin}/support/capture/sessions/${session.id}`;
      return c.json({ token: session.id, recordingUrl });
    }

    const publicKey = await findCapturePublicKeyByKey(db, publicKeyValue!);
    if (!publicKey) {
      throw new VortexError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid public key",
      });
    }

    assertOriginAllowed(publicKey, requestOrigin);

    if (c.env.TURNSTILE_SECRET_KEY) {
      const rawBody = await c.req.json().catch(() => null);
      const turnstileToken =
        isRecord(rawBody) && typeof rawBody.turnstileToken === "string"
          ? rawBody.turnstileToken
          : undefined;
      const turnstileOk = turnstileToken
        ? await verifyTurnstile(
            c.env.TURNSTILE_SECRET_KEY,
            turnstileToken,
            c.req.header("cf-connecting-ip")
          )
        : false;
      if (!turnstileOk) {
        throw new VortexError({
          status: 403,
          code: "CAPTURE_CHALLENGE_REQUIRED",
          message: "A Turnstile challenge token is required",
          details: { siteKey: c.env.TURNSTILE_SITE_KEY ?? null },
        });
      }
    }

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

    // Batch mode declares every artifact in one write so parallel
    // declarations cannot drop entries; the single-artifact shape stays
    // for backward compatibility with older clients.
    const declared =
      body.artifacts && body.artifacts.length > 0
        ? body.artifacts
        : [
            {
              attachmentType: body.attachmentType,
              contentType: body.contentType,
              fileName: body.fileName,
            },
          ];

    const seenKeys = new Set<string>();
    const uploads = declared.map((artifact) => {
      const attachmentType = artifact.attachmentType;
      const contentType =
        artifact.contentType ?? defaultContentTypeForAttachment(attachmentType);
      const fileName =
        typeof artifact.fileName === "string" && artifact.fileName.length > 0
          ? artifact.fileName
          : attachmentType;
      const r2Key = buildCaptureArtifactKey(
        session.organizationId,
        session.id,
        { attachmentType, fileName }
      );
      const deduped = seenKeys.has(r2Key);
      seenKeys.add(r2Key);
      return {
        attachmentType,
        contentType,
        fileName,
        r2Key,
        uploaded: false,
        size: null,
        uploadUrl: `/support/capture/upload/${session.id}/${attachmentType}/${encodeURIComponent(fileName)}`,
        deduped,
      };
    });

    const existingUploads = uploadsFromSession(session);
    const newUploads = uploads.filter((u) => !u.deduped);
    const nextUploads = [
      ...existingUploads.filter(
        (u) => !newUploads.some((n) => n.r2Key === u.r2Key)
      ),
      ...newUploads.map(
        ({ uploadUrl: _uploadUrl, deduped: _deduped, ...u }) => u
      ),
    ];

    const {
      metadata: customMetadata,
      artifacts: _artifacts,
      replayEvents: bodyReplayEvents,
      ...rest
    } = body;
    // Replay events may arrive top-level or inside metadata (older SDKs
    // route everything through the metadata bag). Either way they are too
    // large for the D1 metadata column — they persist as replay.json in R2.
    const { replayEvents: metaReplayEvents, ...safeCustomMetadata } =
      customMetadata && typeof customMetadata === "object"
        ? customMetadata
        : { replayEvents: undefined };
    const replayEvents =
      Array.isArray(bodyReplayEvents) && bodyReplayEvents.length > 0
        ? bodyReplayEvents
        : Array.isArray(metaReplayEvents) && metaReplayEvents.length > 0
          ? metaReplayEvents
          : null;

    const bucket = c.env.ATTACHMENTS_BUCKET;

    // PILE-675 — rrweb DOM replay → replay.json capture artifact.
    if (
      replayEvents &&
      bucket &&
      !nextUploads.some(
        (u) => u.attachmentType === "replay" && u.fileName === "replay.json"
      )
    ) {
      const replayKey = buildCaptureArtifactKey(
        session.organizationId,
        session.id,
        { attachmentType: "replay", fileName: "replay.json" }
      );
      const replayBytes = jsonArtifactBytes(replayEvents);
      await bucket.put(
        replayKey,
        new Blob([replayBytes as BlobPart], {
          type: "application/json",
        }),
        { httpMetadata: { contentType: "application/json" } }
      );
      nextUploads.push({
        attachmentType: "replay",
        contentType: "application/json",
        fileName: "replay.json",
        r2Key: replayKey,
        uploaded: true,
        size: replayBytes.byteLength,
      });
    }

    const merged: Record<string, unknown> = {
      ...session.metadata,
      ...rest,
      ...safeCustomMetadata,
      uploads: nextUploads,
    };
    // Recording-link sessions always publish: the recorder must get a
    // shareable view URL back, which requires public artifact access.
    if (session.linkId) {
      merged.visibility = "public";
    }

    // PILE-665 — mint an R2 multipart upload for the declared video so the
    // client streams MediaRecorder chunks via /upload/part while recording.
    let multipartUploadId: string | undefined;
    if (body.multipart === true && bucket) {
      const target =
        uploads.find((u) => u.attachmentType === "video") ?? uploads[0];
      if (target) {
        const multipart = await bucket.createMultipartUpload(target.r2Key, {
          httpMetadata: { contentType: target.contentType },
        });
        multipartUploadId = multipart.uploadId;
        merged.multipartUploadId = multipart.uploadId;
        merged.multipartObjectKey = target.r2Key;
        merged.multipartParts = [];
        merged.multipartCompleted = false;
      }
    }

    await updateCaptureSessionMetadata(db, session.id, merged);

    const origin = new URL(c.req.url).origin;
    const first = uploads[0];
    return c.json({
      uploadUrl: first?.uploadUrl ?? "",
      r2Key: first?.r2Key ?? "",
      sessionId: session.id,
      ...(multipartUploadId
        ? {
            uploadId: multipartUploadId,
            partUploadUrl: `/support/capture/sessions/${session.id}/upload/part`,
          }
        : {}),
      // PILE-665/668 — the share link is session-scoped so it is valid the
      // moment recording starts, long before a ticket exists.
      ...(merged.visibility === "public"
        ? { shareUrl: `${origin}/support/capture/share/${session.id}` }
        : {}),
      uploads: uploads.map(
        ({ uploadUrl, r2Key, attachmentType, fileName }) => ({
          uploadUrl,
          r2Key,
          attachmentType: attachmentType as CaptureArtifactKind,
          fileName,
        })
      ),
    });
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
    const contentEncoding = c.req.header("content-encoding");
    let arrayBuffer = await c.req.arrayBuffer();

    // Server-side credential scrubbing for text artifacts. Skipped when the
    // payload is content-encoded (e.g. gzip) since we cannot scrub without
    // decoding — the SDK's client-side sanitize still applies there.
    if (!contentEncoding && SCRUBBABLE_ATTACHMENT_TYPES.has(attachmentType)) {
      const scrubbed = scrubCaptureText(new TextDecoder().decode(arrayBuffer));
      arrayBuffer = new TextEncoder().encode(scrubbed).buffer as ArrayBuffer;
    }

    const r2Key = buildCaptureArtifactKey(session.organizationId, session.id, {
      attachmentType,
      fileName,
    });
    // R2 object existence is the source of truth for "uploaded" —
    // finalize verifies each declared artifact with bucket.head(), so no
    // session-metadata write happens here and parallel uploads cannot
    // clobber each other's marks.
    await bucket.put(r2Key, new Blob([arrayBuffer], { type: contentType }), {
      httpMetadata: {
        contentType,
        ...(contentEncoding ? { contentEncoding } : {}),
      },
    });

    return c.json({ r2Key });
  });

  app.openapi(uploadPartPutRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const { partNumber, uploadId } = c.req.valid("query");
    return c.json(
      await streamUploadPart(c, { sessionId, partNumber, uploadId })
    );
  });

  app.openapi(uploadPartPostRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const { partNumber, uploadId } = c.req.valid("query");
    return c.json(
      await streamUploadPart(c, { sessionId, partNumber, uploadId })
    );
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

    // PILE-665 — completing the multipart upload materializes the R2
    // object so the artifact registration below sees the video.
    await completeStreamedCaptureUpload(c.env.ATTACHMENTS_BUCKET, db, session);

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
    const bucket = c.env.ATTACHMENTS_BUCKET;
    const declaredUploads = uploadsFromSession(session);
    // R2 object existence is the source of truth: a declared artifact only
    // becomes a ticket attachment when its bytes actually landed.
    const uploads = (
      await Promise.all(
        declaredUploads.map(async (upload) => {
          if (!bucket || typeof upload.r2Key !== "string") return null;
          const head = await bucket.head(upload.r2Key);
          if (!head) return null;
          return Object.assign({}, upload, { size: head.size });
        })
      )
    ).filter((u): u is NonNullable<typeof u> => u !== null);

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
          type: upload.attachmentType as CaptureArtifactKind,
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

    // PILE-664 — every recording gets a Whisper transcript so agents and
    // triage can read what the reporter said. Deferred past the response;
    // a missing AI binding or a model failure leaves the ticket untouched.
    const transcriptions = uploads
      .filter(
        (upload) =>
          upload.attachmentType === "video" && typeof upload.r2Key === "string"
      )
      .map((upload) =>
        transcribeCaptureRecording(db, c.env, {
          organizationId: session.organizationId,
          ticketId: ticket.id,
          eventId: event.id,
          recordingR2Key: upload.r2Key,
          artifactPrefix: `${session.organizationId}/capture/${session.id}`,
          origin,
          regenerateTitle:
            typeof meta.title !== "string" || meta.title === "Bug report",
        })
      );
    if (transcriptions.length > 0) {
      await kickCaptureTranscription(c, Promise.all(transcriptions));
    }

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
    const headers: Record<string, string> = {
      "Content-Type": contentType,
    };
    if (object.httpMetadata?.contentEncoding) {
      headers["Content-Encoding"] = object.httpMetadata.contentEncoding;
    }
    return c.body(object.body, 200, headers);
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
    const bucket = c.env.ATTACHMENTS_BUCKET;
    const uploadedKeys = new Set(
      bucket
        ? (
            await Promise.all(
              uploads.map(async (u) =>
                typeof u.r2Key === "string" && (await bucket.head(u.r2Key))
                  ? u.r2Key
                  : null
              )
            )
          ).filter((k): k is string => k !== null)
        : []
    );
    const viewCount =
      typeof session.metadata.viewCount === "number"
        ? session.metadata.viewCount
        : 0;
    const lastViewedAt =
      typeof session.metadata.lastViewedAt === "string"
        ? session.metadata.lastViewedAt
        : null;
    return c.json({
      sessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      ticketId: session.ticketId,
      reference,
      viewCount,
      lastViewedAt,
      uploads: uploads.map((u) => ({
        attachmentType: u.attachmentType,
        contentType: u.contentType ?? null,
        r2Key: u.r2Key,
        uploaded: uploadedKeys.has(u.r2Key),
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
      .select({
        id: supportCaptureSessions.id,
        metadata: supportCaptureSessions.metadata,
        createdAt: supportCaptureSessions.createdAt,
      })
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

    // PILE-669 — every share-link open counts as a view.
    const viewedMeta = await recordShareView(db, session.id, meta ?? {});
    const viewCount =
      typeof viewedMeta.viewCount === "number" ? viewedMeta.viewCount : 0;
    const lastViewedAt =
      typeof viewedMeta.lastViewedAt === "string"
        ? viewedMeta.lastViewedAt
        : null;

    const attachments = await db
      .select({
        type: supportTicketAttachments.type,
        fileName: supportTicketAttachments.fileName,
        contentType: supportTicketAttachments.contentType,
        url: supportTicketAttachments.url,
        size: supportTicketAttachments.size,
        r2Key: supportTicketAttachments.r2Key,
      })
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, ticketId));

    // Browsers get the watch page; API/agent clients get the JSON manifest.
    if (c.req.header("accept")?.includes("text/html")) {
      return c.html(
        await buildShareWatchPageHtml(c.env.ATTACHMENTS_BUCKET, {
          title: ticket.title,
          meta: viewedMeta,
          sessionCreatedAt: session.createdAt,
          viewCount,
          lastViewedAt,
          attachments,
          pending: false,
        })
      );
    }

    return c.json({
      ticketId: ticket.id,
      title: ticket.title,
      viewCount,
      lastViewedAt,
      attachments: attachments.map((a) => ({
        type: a.type,
        fileName: a.fileName,
        contentType: a.contentType,
        url: a.url,
        size: a.size,
      })),
    });
  });

  // PILE-665/668 — session-scoped share link: valid the moment recording
  // starts, so the recorder can hand out a watch URL before finalize. Once
  // the session lands a ticket it serves the same watch page/manifest.
  app.openapi(sessionShareRoute, async (c) => {
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
    const meta = session.metadata;
    if (meta.visibility !== "public") {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Capture session not found",
      });
    }

    const viewedMeta = await recordShareView(db, session.id, meta);
    const viewCount =
      typeof viewedMeta.viewCount === "number" ? viewedMeta.viewCount : 0;
    const lastViewedAt =
      typeof viewedMeta.lastViewedAt === "string"
        ? viewedMeta.lastViewedAt
        : null;

    const ticket = session.ticketId
      ? await db
          .select({ id: supportTickets.id, title: supportTickets.title })
          .from(supportTickets)
          .where(eq(supportTickets.id, session.ticketId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;

    const attachments: ShareAttachmentRow[] = ticket
      ? await db
          .select({
            type: supportTicketAttachments.type,
            fileName: supportTicketAttachments.fileName,
            contentType: supportTicketAttachments.contentType,
            url: supportTicketAttachments.url,
            size: supportTicketAttachments.size,
            r2Key: supportTicketAttachments.r2Key,
          })
          .from(supportTicketAttachments)
          .where(eq(supportTicketAttachments.ticketId, ticket.id))
      : [];

    const title =
      ticket?.title ??
      (typeof viewedMeta.title === "string" ? viewedMeta.title : null) ??
      "Shared capture";

    if (c.req.header("accept")?.includes("text/html")) {
      return c.html(
        await buildShareWatchPageHtml(c.env.ATTACHMENTS_BUCKET, {
          title,
          meta: viewedMeta,
          sessionCreatedAt: session.createdAt,
          viewCount,
          lastViewedAt,
          attachments,
          pending: ticket === null,
        })
      );
    }

    return c.json({
      sessionId: session.id,
      status: session.status,
      ticketId: ticket?.id ?? null,
      title,
      viewCount,
      lastViewedAt,
      attachments: attachments.map((a) => ({
        type: a.type,
        fileName: a.fileName,
        contentType: a.contentType,
        url: a.url,
        size: a.size,
      })),
    });
  });

  // The capture SDK's browser bundle — the one-tag embed:
  // <script src="https://pile.nyc/capture.js" data-pile-key="pil_…" data-pile-widget>
  app.get("/capture.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    c.header("cache-control", "public, max-age=300");
    c.header("access-control-allow-origin", "*");
    return c.body(captureSdkBundle);
  });

  // Public zero-install recording page — the link token is the credential.
  // Agents skip this page entirely and drive the protocol API directly.
  app.get("/cap/:token", async (c) => {
    const token = c.req.param("token");
    const db = createD1(c.env.D1);
    const link = await findCaptureLinkByToken(db, token);
    const valid =
      link !== null &&
      (link.expiresAt === null || link.expiresAt > new Date().toISOString());
    return c.html(
      renderCaptureLinkPage({
        token,
        linkName: link?.name ?? "Capture link",
        valid,
        requireChallenge: Boolean(
          link?.requireChallenge && c.env.TURNSTILE_SITE_KEY
        ),
        siteKey: c.env.TURNSTILE_SITE_KEY,
      })
    );
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
    middleware: [rls("ticket:view")],
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
    middleware: [rls("ticket:view")],
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
    middleware: [rls("ticket:view")],
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
    middleware: [rls("ticket:view")],
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
    middleware: [rls("ticket:view")],
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

  // PILE-664 — video jams get the same transcript pass once the media is
  // mirrored into R2. The processor runs inside the queue handler so this
  // await is bounded by the queue's execution budget; the call never throws.
  await Promise.all(
    remoteAttachments
      .filter((attachment) => attachment.type === "video")
      .map(() =>
        transcribeCaptureRecording(db, env, {
          organizationId,
          ticketId: ticket.id,
          eventId: event.id,
          recordingR2Key: `${organizationId}/jam/${parsed.jamId}/video`,
          artifactPrefix: `${organizationId}/jam/${parsed.jamId}`,
          origin,
          regenerateTitle: !parsed.title,
        })
      )
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
