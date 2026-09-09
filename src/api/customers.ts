import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const customerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  logoUrl: z.string().nullable(),
  externalId: z.string().nullable(),
  tierId: z.string().nullable(),
  statusId: z.string().nullable(),
  ownerId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCustomerSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  logoUrl: z.string().optional(),
  externalId: z.string().optional(),
  tierId: z.string().optional(),
  statusId: z.string().optional(),
  ownerId: z.string().optional(),
});

const updateCustomerSchema = createCustomerSchema.partial();

const tierSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  position: z.number(),
  createdAt: z.string(),
});

const tierBodySchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  position: z.number().optional(),
});

const needSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  issueId: z.string().nullable(),
  projectId: z.string().nullable(),
  priority: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

const needBodySchema = z.object({
  customerId: z.string().min(1),
  issueId: z.string().optional(),
  projectId: z.string().optional(),
  priority: z.string().optional(),
  note: z.string().optional(),
});

function notFound(message = "Not found"): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message });
}

const orgParam = z.object({ organizationId: z.string() });
const orgIdParam = z.object({
  organizationId: z.string(),
  id: z.string(),
});

const listCustomersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Customer list",
      content: {
        "application/json": {
          schema: z.object({ customers: z.array(customerSchema) }),
        },
      },
    },
  },
});

const createCustomerRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customers",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: createCustomerSchema } },
    },
  },
  responses: {
    201: {
      description: "Customer created",
      content: { "application/json": { schema: customerSchema } },
    },
  },
});

const getCustomerRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customers/{id}",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Customer",
      content: { "application/json": { schema: customerSchema } },
    },
    404: { description: "Customer not found" },
  },
});

const updateCustomerRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customers/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: updateCustomerSchema } },
    },
  },
  responses: {
    200: {
      description: "Customer updated",
      content: { "application/json": { schema: customerSchema } },
    },
    404: { description: "Customer not found" },
  },
});

const deleteCustomerRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customers/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Customer deleted" },
    404: { description: "Customer not found" },
  },
});

const listTiersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-tiers",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Customer tiers",
      content: {
        "application/json": {
          schema: z.object({ tiers: z.array(tierSchema) }),
        },
      },
    },
  },
});

const createTierRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customer-tiers",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: tierBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Tier created",
      content: { "application/json": { schema: tierSchema } },
    },
  },
});

const getTierRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-tiers/{id}",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Tier",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Tier not found" },
  },
});

const updateTierRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customer-tiers/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: tierBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Tier updated",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Tier not found" },
  },
});

const deleteTierRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customer-tiers/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Tier deleted" },
    404: { description: "Tier not found" },
  },
});

const listStatusesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-statuses",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Customer statuses",
      content: {
        "application/json": {
          schema: z.object({ statuses: z.array(tierSchema) }),
        },
      },
    },
  },
});

const createStatusRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customer-statuses",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: tierBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Status created",
      content: { "application/json": { schema: tierSchema } },
    },
  },
});

const getStatusRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-statuses/{id}",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Status",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Status not found" },
  },
});

const updateStatusRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customer-statuses/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: tierBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Status updated",
      content: { "application/json": { schema: tierSchema } },
    },
    404: { description: "Status not found" },
  },
});

const deleteStatusRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customer-statuses/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Status deleted" },
    404: { description: "Status not found" },
  },
});

const listNeedsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-needs",
  tags: ["customers"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: z.object({
      customerId: z.string().optional(),
      issueId: z.string().optional(),
      projectId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Customer needs",
      content: {
        "application/json": {
          schema: z.object({ needs: z.array(needSchema) }),
        },
      },
    },
  },
});

const createNeedRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/customer-needs",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: needBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Need created",
      content: { "application/json": { schema: needSchema } },
    },
  },
});

const getNeedRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/customer-needs/{id}",
  tags: ["customers"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Need",
      content: { "application/json": { schema: needSchema } },
    },
    404: { description: "Need not found" },
  },
});

const updateNeedRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/customer-needs/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: needBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Need updated",
      content: { "application/json": { schema: needSchema } },
    },
    404: { description: "Need not found" },
  },
});

const deleteNeedRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/customer-needs/{id}",
  tags: ["customers"],
  middleware: [rls("write")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Need deleted" },
    404: { description: "Need not found" },
  },
});

export function registerCustomerRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listCustomersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ customers: await stub.listCustomers() });
  });

  app.openapi(createCustomerRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.createCustomer(input);
    return c.json(customer, 201);
  });

  app.openapi(getCustomerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.getCustomer(id);
    if (!customer) return notFound("Customer not found");
    return c.json(customer);
  });

  app.openapi(updateCustomerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const customer = await stub.updateCustomer(id, input, identity.id);
    if (!customer) return notFound("Customer not found");
    return c.json(customer);
  });

  app.openapi(deleteCustomerRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const deleted = await stub.deleteCustomer(id, identity.id);
    if (!deleted) return notFound("Customer not found");
    return c.body(null, 204);
  });

  app.openapi(listTiersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ tiers: await stub.listCustomerTiers() });
  });

  app.openapi(createTierRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json(await stub.createCustomerTier(input), 201);
  });

  app.openapi(getTierRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const tier = await stub.getCustomerTier(id);
    if (!tier) return notFound("Tier not found");
    return c.json(tier);
  });

  app.openapi(updateTierRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const tier = await stub.updateCustomerTier(id, input);
    if (!tier) return notFound("Tier not found");
    return c.json(tier);
  });

  app.openapi(deleteTierRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteCustomerTier(id)))
      return notFound("Tier not found");
    return c.body(null, 204);
  });

  app.openapi(listStatusesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ statuses: await stub.listCustomerStatuses() });
  });

  app.openapi(createStatusRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json(await stub.createCustomerStatus(input), 201);
  });

  app.openapi(getStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const status = await stub.getCustomerStatus(id);
    if (!status) return notFound("Status not found");
    return c.json(status);
  });

  app.openapi(updateStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const status = await stub.updateCustomerStatus(id, input);
    if (!status) return notFound("Status not found");
    return c.json(status);
  });

  app.openapi(deleteStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteCustomerStatus(id)))
      return notFound("Status not found");
    return c.body(null, 204);
  });

  app.openapi(listNeedsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ needs: await stub.listCustomerNeeds(query) });
  });

  app.openapi(createNeedRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json(await stub.createCustomerNeed(input, identity.id), 201);
  });

  app.openapi(getNeedRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const need = await stub.getCustomerNeed(id);
    if (!need) return notFound("Need not found");
    return c.json(need);
  });

  app.openapi(updateNeedRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const need = await stub.updateCustomerNeed(id, input, identity.id);
    if (!need) return notFound("Need not found");
    return c.json(need);
  });

  app.openapi(deleteNeedRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteCustomerNeed(id)))
      return notFound("Need not found");
    return c.body(null, 204);
  });
}
