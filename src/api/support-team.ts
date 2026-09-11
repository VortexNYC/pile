import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createSupportTier,
  deleteSupportTier,
  getSupportTier,
  listSupportAgents,
  listSupportTierMembers,
  listSupportTiers,
  removeSupportTierMember,
  setSupportUserStatus,
  addSupportTierMember,
  updateSupportTier,
} from "../global/support-team.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const statusEnum = ["active", "away", "snoozed", "offline"] as const;

const supportUserStatusSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  status: z.enum(statusEnum),
  until: z.string().datetime().optional().nullable(),
  updatedAt: z.string().datetime(),
});

const supportAgentSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  status: z.enum(statusEnum),
  until: z.string().datetime().optional().nullable(),
  openTickets: z.number().int(),
});

const supportTierSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  level: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const orgParam = z.object({ organizationId: z.string() });
const userIdParam = z.object({
  organizationId: z.string(),
  userId: z.string(),
});
const tierIdParam = z.object({
  organizationId: z.string(),
  tierId: z.string(),
});
const tierMemberParam = z.object({
  organizationId: z.string(),
  tierId: z.string(),
  userId: z.string(),
});

const setStatusRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/users/{userId}/status",
  tags: ["support-team"],
  middleware: [rls("write")],
  request: {
    params: userIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(statusEnum),
            until: z.string().datetime().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Status updated",
      content: {
        "application/json": {
          schema: z.object({ status: supportUserStatusSchema }),
        },
      },
    },
  },
});

const listAgentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/agents",
  tags: ["support-team"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Agents",
      content: {
        "application/json": {
          schema: z.object({ agents: z.array(supportAgentSchema) }),
        },
      },
    },
  },
});

const createTierRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tiers",
  tags: ["support-team"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            level: z.number().int(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Tier created",
      content: {
        "application/json": { schema: z.object({ tier: supportTierSchema }) },
      },
    },
  },
});

const listTiersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tiers",
  tags: ["support-team"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Tiers",
      content: {
        "application/json": {
          schema: z.object({ tiers: z.array(supportTierSchema) }),
        },
      },
    },
  },
});

const getTierRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tiers/{tierId}",
  tags: ["support-team"],
  middleware: [rls("read")],
  request: { params: tierIdParam },
  responses: {
    200: {
      description: "Tier",
      content: {
        "application/json": { schema: z.object({ tier: supportTierSchema }) },
      },
    },
    404: { description: "Not found" },
  },
});

const updateTierRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/support/tiers/{tierId}",
  tags: ["support-team"],
  middleware: [rls("write")],
  request: {
    params: tierIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).optional(),
            level: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tier updated",
      content: {
        "application/json": { schema: z.object({ tier: supportTierSchema }) },
      },
    },
    404: { description: "Not found" },
  },
});

const deleteTierRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/tiers/{tierId}",
  tags: ["support-team"],
  middleware: [rls("write")],
  request: { params: tierIdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found" },
  },
});

const addTierMemberRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tiers/{tierId}/members",
  tags: ["support-team"],
  middleware: [rls("write")],
  request: {
    params: tierIdParam,
    body: {
      content: {
        "application/json": { schema: z.object({ userId: z.string() }) },
      },
    },
  },
  responses: {
    201: { description: "Member added" },
    404: { description: "Tier not found" },
  },
});

const removeTierMemberRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/tiers/{tierId}/members/{userId}",
  tags: ["support-team"],
  middleware: [rls("write")],
  request: { params: tierMemberParam },
  responses: {
    204: { description: "Member removed" },
    404: { description: "Member not found" },
  },
});

const listTierMembersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tiers/{tierId}/members",
  tags: ["support-team"],
  middleware: [rls("read")],
  request: { params: tierIdParam },
  responses: {
    200: {
      description: "Tier members",
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(
              z.object({
                userId: z.string(),
                name: z.string(),
                email: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

export function registerSupportTeamRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(setStatusRoute, async (c) => {
    const { organizationId, userId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const status = await setSupportUserStatus(db, organizationId, userId, body);
    return c.json({ status }, 200);
  });

  app.openapi(listAgentsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const agents = await listSupportAgents(db, organizationId);
    return c.json({ agents });
  });

  app.openapi(createTierRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const tier = await createSupportTier(db, organizationId, body);
    return c.json({ tier }, 201);
  });

  app.openapi(listTiersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const tiers = await listSupportTiers(db, organizationId);
    return c.json({ tiers });
  });

  app.openapi(getTierRoute, async (c) => {
    const { organizationId, tierId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const tier = await getSupportTier(db, organizationId, tierId);
    if (!tier) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Tier not found",
      });
    }
    return c.json({ tier });
  });

  app.openapi(updateTierRoute, async (c) => {
    const { organizationId, tierId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const tier = await updateSupportTier(db, organizationId, tierId, body);
    if (!tier) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Tier not found",
      });
    }
    return c.json({ tier });
  });

  app.openapi(deleteTierRoute, async (c) => {
    const { organizationId, tierId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const deleted = await deleteSupportTier(db, organizationId, tierId);
    if (!deleted) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Tier not found",
      });
    }
    return c.body(null, 204);
  });

  app.openapi(addTierMemberRoute, async (c) => {
    const { organizationId, tierId } = c.req.valid("param");
    const { userId: memberUserId } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const tier = await getSupportTier(db, organizationId, tierId);
    if (!tier) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Tier not found",
      });
    }
    await addSupportTierMember(db, tierId, memberUserId);
    return c.body(null, 201);
  });

  app.openapi(removeTierMemberRoute, async (c) => {
    const { tierId, userId: memberUserId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const removed = await removeSupportTierMember(db, tierId, memberUserId);
    if (!removed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Member not found",
      });
    }
    return c.body(null, 204);
  });

  app.openapi(listTierMembersRoute, async (c) => {
    const { organizationId, tierId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const tier = await getSupportTier(db, organizationId, tierId);
    if (!tier) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Tier not found",
      });
    }
    const members = await listSupportTierMembers(db, tierId);
    return c.json({ members });
  });
}
