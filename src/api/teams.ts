import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeamById,
  getVisibleTeamIds,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  updateTeam,
  type TeamRecord,
} from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const teamSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  key: z.string(),
  name: z.string(),
  ownerId: z.string(),
  isDefault: z.boolean(),
  isPublic: z.boolean(),
  parentAutoClose: z.boolean(),
  subIssueAutoClose: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function serializeTeam(record: TeamRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    key: record.key,
    name: record.name,
    ownerId: record.ownerId,
    isDefault: record.isDefault,
    isPublic: record.isPublic,
    parentAutoClose: record.parentAutoClose,
    subIssueAutoClose: record.subIssueAutoClose,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const createTeamBodySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  isPublic: z.boolean().optional(),
  parentAutoClose: z.boolean().optional(),
  subIssueAutoClose: z.boolean().optional(),
});

const updateTeamBodySchema = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  isPublic: z.boolean().optional(),
  parentAutoClose: z.boolean().optional(),
  subIssueAutoClose: z.boolean().optional(),
});

const teamMemberSchema = z.object({
  memberId: z.string(),
  memberType: z.enum(["user", "agent"]),
  role: z.enum(["member", "guest"]).optional(),
});

const listTeamsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/teams",
  tags: ["teams"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Teams list",
      content: {
        "application/json": {
          schema: z.object({ teams: z.array(teamSchema) }),
        },
      },
    },
  },
});

const createTeamRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/teams",
  tags: ["teams"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createTeamBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Team created",
      content: {
        "application/json": { schema: teamSchema },
      },
    },
  },
});

const getTeamRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/teams/{id}",
  tags: ["teams"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Team",
      content: {
        "application/json": { schema: teamSchema },
      },
    },
    404: { description: "Team not found" },
  },
});

const updateTeamRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/teams/{id}",
  tags: ["teams"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: updateTeamBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Team updated",
      content: {
        "application/json": { schema: teamSchema },
      },
    },
    404: { description: "Team not found" },
  },
});

const deleteTeamRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/teams/{id}",
  tags: ["teams"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Team deleted" },
  },
});

const listTeamMembersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/teams/{id}/members",
  tags: ["teams"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Team members",
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(
              z.object({
                memberId: z.string(),
                memberType: z.enum(["user", "agent"]),
                role: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

const addTeamMemberRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/teams/{id}/members",
  tags: ["teams"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: teamMemberSchema },
      },
    },
  },
  responses: {
    204: { description: "Member added" },
  },
});

const removeTeamMemberRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/teams/{id}/members/{memberId}",
  tags: ["teams"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
      memberId: z.string(),
    }),
    query: z.object({
      memberType: z.enum(["user", "agent"]).optional(),
    }),
  },
  responses: {
    204: { description: "Member removed" },
  },
});

function canManageTeam(
  record: TeamRecord,
  identity: {
    id: string;
    permissions: string[];
  }
) {
  return (
    record.ownerId === identity.id || identity.permissions.includes("admin")
  );
}

export function registerTeamRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listTeamsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const visibleIds = new Set(
      await getVisibleTeamIds(db, organizationId, identity)
    );
    const allTeams = await listTeams(db, organizationId);
    const teams = allTeams.filter((t) => visibleIds.has(t.id));
    return c.json({ teams: teams.map(serializeTeam) });
  });

  app.openapi(createTeamRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const record = await createTeam(db, {
      organizationId,
      key: body.key,
      name: body.name,
      ownerId: identity.id,
      isPublic: body.isPublic,
      parentAutoClose: body.parentAutoClose,
      subIssueAutoClose: body.subIssueAutoClose,
    });
    return c.json(serializeTeam(record), 201);
  });

  app.openapi(getTeamRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const record = await getTeamById(db, id, organizationId);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    const visibleIds = new Set(
      await getVisibleTeamIds(db, organizationId, identity)
    );
    if (!visibleIds.has(record.id)) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    return c.json(serializeTeam(record));
  });

  app.openapi(updateTeamRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const existing = await getTeamById(db, id, organizationId);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    if (!canManageTeam(existing, identity)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot update this team",
      });
    }
    const record = await updateTeam(db, id, organizationId, body);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    return c.json(serializeTeam(record));
  });

  app.openapi(deleteTeamRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const existing = await getTeamById(db, id, organizationId);
    if (!existing) {
      return c.body(null, 204);
    }
    if (existing.isDefault) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Cannot delete the default team",
      });
    }
    if (!canManageTeam(existing, identity)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot delete this team",
      });
    }
    await deleteTeam(db, id, organizationId);
    return c.body(null, 204);
  });

  app.openapi(listTeamMembersRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const record = await getTeamById(db, id, organizationId);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    const visibleIds = new Set(
      await getVisibleTeamIds(db, organizationId, identity)
    );
    if (!visibleIds.has(record.id)) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    const members = await listTeamMembers(db, id);
    return c.json({ members });
  });

  app.openapi(addTeamMemberRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const record = await getTeamById(db, id, organizationId);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    if (!canManageTeam(record, identity)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot manage this team",
      });
    }
    await addTeamMember(db, organizationId, id, body.memberId, body.memberType);
    return c.body(null, 204);
  });

  app.openapi(removeTeamMemberRoute, async (c) => {
    const { organizationId, id, memberId } = c.req.valid("param");
    const { memberType } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const record = await getTeamById(db, id, organizationId);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    if (!canManageTeam(record, identity)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot manage this team",
      });
    }
    await removeTeamMember(db, id, memberId, memberType ?? "user");
    return c.body(null, 204);
  });
}
