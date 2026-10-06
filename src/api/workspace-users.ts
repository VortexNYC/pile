import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { isAPIError } from "better-auth/api";
import { and, desc, eq, gt, notInArray } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { invitation, member, user as userTable } from "../global/schema.js";
import { createAuth } from "../platform/auth.js";
import { errorCodeFromStatus, VortexError } from "../platform/errors.js";
import { workspaceRoleSchema } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { emitWorkspaceAudit } from "./audit-emit.js";

function mapAuthError(error: unknown): never {
  if (isAPIError(error)) {
    const status = error.statusCode;
    throw new VortexError({
      code: errorCodeFromStatus(status),
      status,
      message: error.message,
    });
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

const createInvitationRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/invitations",
  tags: ["workspace-users"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            role: workspaceRoleSchema,
            teamId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Invitation created",
      content: { "application/json": { schema: invitationSchema } },
    },
    400: {
      description:
        "Invalid email, unknown team, or the address already belongs to a member or pending invitation",
    },
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/invitations",
  tags: ["workspace-users"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      status: z
        .enum(["pending", "accepted", "canceled", "rejected", "all"])
        .optional()
        .openapi({
          description: "Invitation status filter; defaults to pending",
        }),
    }),
  },
  responses: {
    200: {
      description: "Invitations list",
      content: {
        "application/json": {
          schema: z.object({ invitations: z.array(invitationSchema) }),
        },
      },
    },
  },
});

const cancelInvitationRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/invitations/{id}",
  tags: ["workspace-users"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Invitation canceled" },
    404: { description: "Invitation not found" },
    409: { description: "Invitation is not pending" },
  },
});

async function findInvitation(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(invitation)
    .where(
      and(eq(invitation.id, id), eq(invitation.organizationId, organizationId))
    )
    .get();
}

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
    const auth = await createAuth(c.env);
    try {
      await auth.api.leaveOrganization({
        headers: c.req.raw.headers,
        body: { organizationId },
      });
    } catch (error) {
      mapAuthError(error);
    }
    await emitWorkspaceAudit(
      c,
      organizationId,
      "member.left",
      "member",
      c.var.workspaceIdentity?.id ?? "unknown"
    );
    return c.body(null, 204);
  });

  app.openapi(createInvitationRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    // Owner invitations stay behind a signed-in owner identity. API keys
    // resolve to the referenceId user's session inside better-auth — and
    // agent-minted keys point at the workspace owner — so key metadata
    // alone must not be able to grant the top role.
    if (input.role === "owner" && c.var.workspaceIdentity.role !== "owner") {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only workspace owners can invite owners",
      });
    }
    const auth = await createAuth(c.env);
    let result: unknown;
    try {
      result = await auth.api.createInvitation({
        headers: c.req.raw.headers,
        body: {
          email: input.email,
          organizationId,
          role: input.role,
          teamId: input.teamId,
        },
      });
    } catch (error) {
      mapAuthError(error);
    }

    const parsed = z.object({ id: z.string() }).safeParse(result);
    if (!parsed.success) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Invitation creation returned an unexpected response",
      });
    }
    const db = createD1(c.env.D1);
    const created = await findInvitation(db, organizationId, parsed.data.id);
    if (!created) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Invitation not found after creation",
      });
    }
    await emitWorkspaceAudit(
      c,
      organizationId,
      "invitation.created",
      "invitation",
      created.id,
      {
        email: { from: null, to: created.email },
        role: { from: null, to: created.role },
      }
    );
    return c.json(toInvitationResponse(created), 201);
  });

  app.openapi(listInvitationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const statusFilter = status ?? "pending";
    const db = createD1(c.env.D1);
    const rows = await db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, organizationId),
          statusFilter === "all"
            ? undefined
            : and(
                eq(invitation.status, statusFilter),
                // "pending" means still actionable — expired rows are dead
                // to better-auth's accept flow, so keep them out of the
                // default view (they remain visible via status=all).
                statusFilter === "pending"
                  ? gt(invitation.expiresAt, new Date())
                  : undefined
              )
        )
      )
      .orderBy(desc(invitation.createdAt))
      .all();
    return c.json({ invitations: rows.map(toInvitationResponse) });
  });

  app.openapi(cancelInvitationRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    // One conditional write, scoped to this workspace and pending status:
    // better-auth's cancelInvitation authorizes against the invitation's
    // own org and flips status unconditionally, so scoping here both blocks
    // cross-workspace cancels and keeps an in-flight accept from being
    // overwritten.
    const canceled = await db
      .update(invitation)
      .set({ status: "canceled" })
      .where(
        and(
          eq(invitation.id, id),
          eq(invitation.organizationId, organizationId),
          eq(invitation.status, "pending")
        )
      )
      .returning({ id: invitation.id })
      .get();
    if (!canceled) {
      const existing = await findInvitation(db, organizationId, id);
      if (!existing) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Invitation not found",
        });
      }
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: `Invitation is ${existing.status}; only pending invitations can be canceled`,
      });
    }
    await emitWorkspaceAudit(
      c,
      organizationId,
      "invitation.canceled",
      "invitation",
      id,
      { status: { from: "pending", to: "canceled" } }
    );
    return c.body(null, 204);
  });

  app.openapi(resendInviteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const invite = await findInvitation(db, organizationId, id);
    if (!invite) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Invitation not found",
      });
    }

    const auth = await createAuth(c.env);
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
