import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, notInArray } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { invitation, member, user as userTable } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

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
  middleware: [rls("write")],
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
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const me = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, identity.id)
        )
      )
      .get();
    if (!me) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Member not found",
      });
    }
    if (me.role === "owner") {
      const owners = await db
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.role, "owner")
          )
        )
        .all();
      if (owners.length <= 1) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Cannot leave workspace as the only owner",
        });
      }
    }
    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, identity.id)
        )
      );
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
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await db
      .update(invitation)
      .set({
        status: "pending",
        expiresAt,
      })
      .where(eq(invitation.id, id));

    if (c.env.EMAIL && c.env.EMAIL_FROM && c.env.BETTER_AUTH_URL) {
      try {
        const acceptUrl = `${c.env.BETTER_AUTH_URL}/api/auth/organization/accept-invitation?invitationId=${encodeURIComponent(invite.id)}`;
        const raw = [
          `From: ${c.env.EMAIL_FROM}`,
          `To: ${invite.email}`,
          `Subject: Invitation to join the workspace`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="utf-8"',
          "",
          `You have been invited to join the workspace. Accept here: ${acceptUrl}`,
        ].join("\r\n");
        const { EmailMessage } = await import("cloudflare:email");
        await c.env.EMAIL.send(
          new EmailMessage(c.env.EMAIL_FROM, invite.email, raw)
        );
      } catch {
        // Email is best-effort.
      }
    }

    const updated = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, id))
      .get();
    return c.json(updated!);
  });
}
