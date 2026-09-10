import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { isAPIError } from "better-auth/api";
import { and, eq, notInArray } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { invitation, member, user as userTable } from "../global/schema.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import { workspaceRoleSchema } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

function mapAuthError(error: unknown): never {
  if (isAPIError(error)) {
    const status = error.statusCode;
    const code =
      status === 401
        ? "UNAUTHORIZED"
        : status === 403
          ? "FORBIDDEN"
          : status === 404
            ? "NOT_FOUND"
            : status === 400
              ? "BAD_REQUEST"
              : "INTERNAL_ERROR";
    throw new VortexError({ code, status, message: error.message });
  }
  throw error;
}

function toInvitationResponse(
  row: typeof invitation.$inferSelect
): z.infer<typeof invitationSchema> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    status: row.status,
    teamId: row.teamId ?? null,
    expiresAt: row.expiresAt.getTime(),
    inviterId: row.inviterId,
    createdAt: row.createdAt.getTime(),
  };
}

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});

const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  teamId: z.string().nullable(),
  expiresAt: z.number().int(),
  inviterId: z.string(),
  createdAt: z.number().int(),
});

const availableUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/available-users",
  tags: ["workspace-users"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({ q: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Users not in this workspace",
      content: {
        "application/json": {
          schema: z.object({ users: z.array(userSchema) }),
        },
      },
    },
  },
});

const leaveOrganizationRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/leave",
  tags: ["workspace-users"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    204: { description: "Left workspace" },
    400: { description: "Cannot leave as only owner" },
  },
});

const resendInviteRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/invitations/{id}/resend",
  tags: ["workspace-users"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Invitation resent",
      content: { "application/json": { schema: invitationSchema } },
    },
    404: { description: "Invitation not found" },
    503: { description: "Email not configured" },
  },
});

export function registerWorkspaceUserRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(availableUsersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { q } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const members = await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, organizationId))
      .all();
    const memberIds = members.map((m) => m.userId);
    const rows = await db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
      })
      .from(userTable)
      .where(
        memberIds.length > 0 ? notInArray(userTable.id, memberIds) : undefined
      )
      .all();
    const filtered = q
      ? rows.filter(
          (u) =>
            u.name.toLowerCase().includes(q.toLowerCase()) ||
            u.email.toLowerCase().includes(q.toLowerCase())
        )
      : rows;
    return c.json({ users: filtered });
  });

  app.openapi(leaveOrganizationRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const auth = createAuth(c.env);
    try {
      await auth.api.leaveOrganization({
        headers: c.req.raw.headers,
        body: { organizationId },
      });
    } catch (error) {
      mapAuthError(error);
    }
    return c.body(null, 204);
  });

  app.openapi(resendInviteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const invite = await db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.id, id),
          eq(invitation.organizationId, organizationId)
        )
      )
      .get();
    if (!invite) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Invitation not found",
      });
    }

    const auth = createAuth(c.env);
    let result: unknown;
    try {
      result = await auth.api.createInvitation({
        headers: c.req.raw.headers,
        body: {
          email: invite.email,
          organizationId,
          role: workspaceRoleSchema.parse(invite.role),
          resend: true,
          teamId: invite.teamId ?? undefined,
        },
      });
    } catch (error) {
      mapAuthError(error);
    }

    const parsed = z.object({ id: z.string() }).safeParse(result);
    const invitationId = parsed.success ? parsed.data.id : id;
    const updated = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .get();
    if (!updated) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Invitation not found",
      });
    }
    return c.json(toInvitationResponse(updated));
  });
}
