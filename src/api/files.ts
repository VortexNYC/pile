import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const fileSchema = z.object({
  id: z.string(),
  key: z.string(),
  url: z.string(),
  contentType: z.string(),
  size: z.number().int(),
});

const uploadBodySchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().optional(),
  contentBase64: z.string().min(1),
});

const fromUrlBodySchema = z.object({
  url: z.string().url(),
  filename: z.string().optional(),
});

function r2Key(organizationId: string, id: string, filename: string) {
  return `${organizationId}/files/${id}/${filename}`;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return new Uint8Array(
    Array.from(binary, (char) => char.charCodeAt(0))
  );
}

const uploadRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/files",
  tags: ["files"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: uploadBodySchema } } },
  },
  responses: {
    201: {
      description: "File uploaded",
      content: { "application/json": { schema: fileSchema } },
    },
    503: { description: "File storage not configured" },
  },
});

const uploadFromUrlRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/images/from-url",
  tags: ["files"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: fromUrlBodySchema } } },
  },
  responses: {
    201: {
      description: "Image uploaded",
      content: { "application/json": { schema: fileSchema } },
    },
    503: { description: "File storage not configured" },
  },
});

const getFileRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/files",
  tags: ["files"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({ key: z.string() }),
  },
  responses: {
    200: { description: "File content" },
    404: { description: "File not found" },
    503: { description: "File storage not configured" },
  },
});

export function registerFileRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(uploadRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "File storage not configured",
      });
    }
    const id = crypto.randomUUID();
    const contentType = input.contentType || "application/octet-stream";
    const key = r2Key(organizationId, id, input.filename);
    const bytes = base64ToBytes(input.contentBase64);
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
    return c.json(
      {
        id,
        key,
        url: `/workspaces/${organizationId}/files?key=${encodeURIComponent(key)}`,
        contentType,
        size: bytes.length,
      },
      201
    );
  });

  app.openapi(uploadFromUrlRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "File storage not configured",
      });
    }
    const response = await fetch(input.url);
    if (!response.ok) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Failed to fetch image",
      });
    }
    const arrayBuffer = await response.arrayBuffer();
    const id = crypto.randomUUID();
    const filename =
      input.filename ||
      new URL(input.url).pathname.split("/").pop() ||
      "image";
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const key = r2Key(organizationId, id, filename);
    await bucket.put(key, new Uint8Array(arrayBuffer), {
      httpMetadata: { contentType },
    });
    return c.json(
      {
        id,
        key,
        url: `/workspaces/${organizationId}/files?key=${encodeURIComponent(key)}`,
        contentType,
        size: arrayBuffer.byteLength,
      },
      201
    );
  });

  app.openapi(getFileRoute, async (c) => {
    c.req.valid("param");
    const { key } = c.req.valid("query");
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "File storage not configured",
      });
    }
    const object = await bucket.get(key);
    if (!object || !object.body) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "File not found",
      });
    }
    const headers: Record<string, string> = {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
    };
    if (object.size) headers["content-length"] = String(object.size);
    return c.body(object.body, { headers });
  });
}
