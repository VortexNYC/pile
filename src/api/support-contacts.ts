import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createCompany,
  createCustomer,
  getCompanyById,
  getCustomerByEmail,
  getCustomerById,
  listCompanies,
  listCustomers,
  resolveCompanyByDomain,
  setCustomerCompanies,
  setCustomerIdentities,
  updateCustomer,
} from "../global/support-contacts.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const identityTypeEnum = z.enum([
  "email",
  "phone",
  "slack",
  "msteams",
  "discord",
  "whatsapp",
  "chat",
  "api",
  "social",
  "custom",
]);

const supportCustomerCompanySchema = z.object({
  id: z.string(),
  customerId: z.string(),
  companyId: z.string(),
  name: z.string(),
  isPrimary: z.boolean(),
  createdAt: z.string(),
});

const supportCustomerIdentitySchema = z.object({
  id: z.string(),
  customerId: z.string(),
  type: identityTypeEnum,
  subType: z.string().nullable(),
  value: z.string(),
  isPrimary: z.boolean(),
  createdAt: z.string(),
});

const supportCustomerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string().nullable(),
  externalId: z.string().nullable(),
  externalSource: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  companies: z.array(supportCustomerCompanySchema),
  identities: z.array(supportCustomerIdentitySchema),
});

const supportCompanySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  externalId: z.string().nullable(),
  externalSource: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCustomerBodySchema = z.object({
  email: z.string().email(),
  fullName: z.string().optional(),
  phone: z.string().optional(),
  userId: z.string().optional(),
  externalId: z.string().optional(),
  externalSource: z.string().optional(),
  companies: z
    .array(
      z.object({
        companyId: z.string(),
        isPrimary: z.boolean().default(false),
      })
    )
    .optional(),
  identities: z
    .array(
      z.object({
        type: identityTypeEnum,
        subType: z.string().optional(),
        value: z.string(),
        isPrimary: z.boolean().default(false),
      })
    )
    .optional(),
});

const updateCustomerBodySchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().optional(),
  phone: z.string().optional(),
  userId: z.string().optional(),
  externalId: z.string().optional(),
  externalSource: z.string().optional(),
});

const setCustomerCompaniesBodySchema = z.object({
  companies: z.array(
    z.object({
      companyId: z.string(),
      isPrimary: z.boolean().default(false),
    })
  ),
});

const setCustomerIdentitiesBodySchema = z.object({
  identities: z.array(
    z.object({
      type: identityTypeEnum,
      subType: z.string().optional(),
      value: z.string(),
      isPrimary: z.boolean().default(false),
    })
  ),
});

const createCompanyBodySchema = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  externalId: z.string().optional(),
  externalSource: z.string().optional(),
});

const orgParam = z.object({ organizationId: z.string() });
const customerIdParam = z.object({
  organizationId: z.string(),
  customerId: z.string(),
});
const companyIdParam = z.object({
  organizationId: z.string(),
  companyId: z.string(),
});

const listCustomersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  companyId: z.string().optional(),
  q: z.string().optional(),
});

const listCompaniesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  q: z.string().optional(),
});

function customerNotFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Customer not found",
  });
}

function companyNotFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Company not found",
  });
}

const createCustomerRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/customers",
  tags: ["support-contacts"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createCustomerBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Customer created",
      content: {
        "application/json": {
          schema: z.object({ customer: supportCustomerSchema }),
        },
      },
    },
  },
});

const listCustomersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/customers",
  tags: ["support-contacts"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: listCustomersQuerySchema,
  },
  responses: {
    200: {
      description: "Customers list",
      content: {
        "application/json": {
          schema: z.object({
            customers: z.array(supportCustomerSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

const getCustomerRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/customers/{customerId}",
  tags: ["support-contacts"],
  middleware: [rls("read")],
  request: {
    params: customerIdParam,
  },
  responses: {
    200: {
      description: "Customer",
      content: {
        "application/json": {
          schema: z.object({ customer: supportCustomerSchema }),
        },
      },
    },
  },
});

const updateCustomerRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/support/customers/{customerId}",
  tags: ["support-contacts"],
  middleware: [rls("write")],
  request: {
    params: customerIdParam,
    body: {
      content: {
        "application/json": { schema: updateCustomerBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Customer updated",
      content: {
        "application/json": {
          schema: z.object({ customer: supportCustomerSchema }),
        },
      },
    },
  },
});

const setCustomerCompaniesRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/support/customers/{customerId}/companies",
  tags: ["support-contacts"],
  middleware: [rls("write")],
  request: {
    params: customerIdParam,
    body: {
      content: {
        "application/json": { schema: setCustomerCompaniesBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Customer companies updated",
      content: {
        "application/json": {
          schema: z.object({ customer: supportCustomerSchema }),
        },
      },
    },
  },
});

const setCustomerIdentitiesRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/support/customers/{customerId}/identities",
  tags: ["support-contacts"],
  middleware: [rls("write")],
  request: {
    params: customerIdParam,
    body: {
      content: {
        "application/json": { schema: setCustomerIdentitiesBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Customer identities updated",
      content: {
        "application/json": {
          schema: z.object({ customer: supportCustomerSchema }),
        },
      },
    },
  },
});

const createCompanyRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/companies",
  tags: ["support-contacts"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createCompanyBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Company created",
      content: {
        "application/json": {
          schema: z.object({ company: supportCompanySchema }),
        },
      },
    },
  },
});

const listCompaniesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/companies",
  tags: ["support-contacts"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: listCompaniesQuerySchema,
  },
  responses: {
    200: {
      description: "Companies list",
      content: {
        "application/json": {
          schema: z.object({
            companies: z.array(supportCompanySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

const getCompanyRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/companies/{companyId}",
  tags: ["support-contacts"],
  middleware: [rls("read")],
  request: {
    params: companyIdParam,
  },
  responses: {
    200: {
      description: "Company",
      content: {
        "application/json": {
          schema: z.object({ company: supportCompanySchema }),
        },
      },
    },
  },
});

export function registerSupportContactRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createCustomerRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const existing = await getCustomerByEmail(db, organizationId, body.email);
    if (existing) {
      const full =
        (await getCustomerById(db, organizationId, existing.id)) ??
        customerNotFound();
      return c.json({ customer: full }, 201);
    }

    const customer = await createCustomer(db, {
      ...body,
      organizationId,
    });

    const companyLinks = body.companies ?? [];

    if (companyLinks.length === 0) {
      const companyId = await resolveCompanyByDomain(
        db,
        organizationId,
        customer.email
      );
      if (companyId) {
        companyLinks.push({ companyId, isPrimary: true });
      }
    }

    if (companyLinks.length > 0) {
      await setCustomerCompanies(db, organizationId, customer.id, companyLinks);
    }

    const identities = body.identities ?? [
      { type: "email" as const, value: customer.email, isPrimary: true },
    ];

    if (identities.length > 0) {
      await setCustomerIdentities(db, organizationId, customer.id, identities);
    }

    const full =
      (await getCustomerById(db, organizationId, customer.id)) ??
      customerNotFound();
    return c.json({ customer: full }, 201);
  });

  app.openapi(listCustomersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const { customers, nextCursor } = await listCustomers(db, organizationId, {
      limit: query.limit,
      cursor: query.cursor,
      companyId: query.companyId,
      q: query.q,
    });

    const withRelations = await Promise.all(
      customers.map((customer) =>
        getCustomerById(db, organizationId, customer.id)
      )
    );

    return c.json({
      customers: withRelations.filter(
        (customer): customer is NonNullable<typeof customer> =>
          customer !== null
      ),
      nextCursor,
    });
  });

  app.openapi(getCustomerRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const customer = await getCustomerById(db, organizationId, customerId);
    if (!customer) {
      customerNotFound();
    }
    return c.json({ customer });
  });

  app.openapi(updateCustomerRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const updated = await updateCustomer(db, organizationId, customerId, body);
    if (!updated) {
      customerNotFound();
    }
    const customer =
      (await getCustomerById(db, organizationId, customerId)) ??
      customerNotFound();
    return c.json({ customer });
  });

  app.openapi(setCustomerCompaniesRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const { companies } = c.req.valid("json");
    const db = createD1(c.env.D1);
    await setCustomerCompanies(db, organizationId, customerId, companies);
    const customer = await getCustomerById(db, organizationId, customerId);
    if (!customer) {
      customerNotFound();
    }
    return c.json({ customer });
  });

  app.openapi(setCustomerIdentitiesRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const { identities } = c.req.valid("json");
    const db = createD1(c.env.D1);
    await setCustomerIdentities(db, organizationId, customerId, identities);
    const customer = await getCustomerById(db, organizationId, customerId);
    if (!customer) {
      customerNotFound();
    }
    return c.json({ customer });
  });

  app.openapi(createCompanyRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const company = await createCompany(db, { ...body, organizationId });
    return c.json({ company }, 201);
  });

  app.openapi(listCompaniesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const { companies, nextCursor } = await listCompanies(db, organizationId, {
      limit: query.limit,
      cursor: query.cursor,
      q: query.q,
    });
    return c.json({ companies, nextCursor });
  });

  app.openapi(getCompanyRoute, async (c) => {
    const { organizationId, companyId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const company = await getCompanyById(db, organizationId, companyId);
    if (!company) {
      companyNotFound();
    }
    return c.json({ company });
  });
}
