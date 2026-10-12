import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { anonymizeCustomer } from "../global/deletion.js";
import {
  createCustomer,
  getCustomerByEmail,
  getCustomerById,
  listCustomers,
  setCustomerCompanies,
  setCustomerIdentities,
  setEmailOptOutByEmail,
  updateCustomer,
} from "../global/support-contacts.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AppContext } from "../platform/middleware.js";
import { publicRateLimit } from "../platform/rate-limit.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

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
  name: z.string().nullable(),
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
  emailOptOut: z.boolean(),
  emailOptOutAt: z.string().nullable(),
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

// One company model: support_companies folded into workspace customers.
// The routes proxy the DO; domain replaces url parsing on the client.
function customerAsCompany(customer: {
  id: string;
  organizationId: string;
  name: string;
  domain: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: customer.id,
    organizationId: customer.organizationId,
    name: customer.name,
    domain: customer.domain,
    externalId: customer.externalId,
    externalSource: "workspace",
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

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
  emailOptOut: z.boolean().optional(),
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
  middleware: [rls("ticket:create")],
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
  middleware: [rls("ticket:view")],
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
  middleware: [rls("ticket:view")],
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
  middleware: [rls("ticket:edit")],
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

const deleteCustomerRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/customers/{customerId}",
  tags: ["support-contacts"],
  middleware: [rls("ticket:delete")],
  request: {
    params: customerIdParam,
  },
  responses: {
    200: {
      description:
        "Customer PII scrubbed — email/name/phone/externalId anonymized, widget sessions removed. Ticket history is kept.",
      content: {
        "application/json": {
          schema: z.object({
            anonymized: z.boolean(),
            sessionsRemoved: z.number(),
          }),
        },
      },
    },
    404: { description: "Customer not found" },
  },
});

const setCustomerCompaniesRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/support/customers/{customerId}/companies",
  tags: ["support-contacts"],
  middleware: [rls("ticket:edit")],
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
  middleware: [rls("ticket:edit")],
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
  middleware: [rls("ticket:create")],
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
  middleware: [rls("ticket:view")],
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
  middleware: [rls("ticket:view")],
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

const listCompanyContactsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/companies/{companyId}/contacts",
  tags: ["support-contacts"],
  middleware: [rls("ticket:view")],
  request: { params: companyIdParam },
  responses: {
    200: {
      description: "Contacts in a company",
      content: {
        "application/json": {
          schema: z.object({ contacts: z.array(supportCustomerSchema) }),
        },
      },
    },
  },
});

export function registerSupportContactRoutes(app: OpenAPIHono<AppContext>) {
  // Public unsubscribe — always returns ok whether or not the email exists
  // (no existence oracle). Per-IP hourly cap.
  app.openapi(
    createRoute({
      method: "post",
      path: "/support/unsubscribe",
      tags: ["support-contacts"],
      summary: "Opt a customer email out of outbound notifications",
      middleware: [
        publicRateLimit({
          bucket: "support-unsubscribe",
          max: 30,
          windowMs: 3_600_000,
        }),
      ],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                organizationId: z.string(),
                email: z.string().trim().email(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Opt-out recorded",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { organizationId, email } = c.req.valid("json");
      const db = createD1(c.env.D1);
      await setEmailOptOutByEmail(db, organizationId, email, true);
      return c.json({ ok: true }, 200);
    }
  );

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
      const companyId = await ensureCustomerByDomain(
        c.env,
        organizationId,
        customer.email
      );
      if (companyId) {
        companyLinks.push({ companyId, isPrimary: true });
      }
    }

    if (companyLinks.length > 0) {
      await setCustomerCompanies(
        db,
        organizationId,
        customer.id,
        companyLinks,
        c.env
      );
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

  app.openapi(deleteCustomerRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const customer = await getCustomerById(db, organizationId, customerId);
    if (!customer) {
      customerNotFound();
    }
    const result = await anonymizeCustomer(db, organizationId, customerId);
    return c.json({ anonymized: true, ...result });
  });

  app.openapi(setCustomerCompaniesRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const { companies } = c.req.valid("json");
    const db = createD1(c.env.D1);
    await setCustomerCompanies(
      db,
      organizationId,
      customerId,
      companies,
      c.env
    );
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
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customer = await stub.createCustomer({
      name: body.name,
      domain: body.domain ?? null,
      externalId: body.externalId ?? null,
    });
    return c.json({ company: customerAsCompany(customer) }, 201);
  });

  app.openapi(listCompaniesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const all = await stub.listCustomers();
    const q = query.q?.toLowerCase();
    const filtered = q
      ? all.filter(
          (row) =>
            row.name.toLowerCase().includes(q) ||
            (row.domain ?? "").toLowerCase().includes(q)
        )
      : all;
    return c.json({
      companies: filtered.map(customerAsCompany),
      nextCursor: null,
    });
  });

  app.openapi(listCompanyContactsRoute, async (c) => {
    const { organizationId, companyId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const { customers } = await listCustomers(db, organizationId, {
      limit: 100,
      companyId,
    });
    const contacts = await Promise.all(
      customers.map((customer) =>
        getCustomerById(db, organizationId, customer.id)
      )
    );
    return c.json(
      {
        contacts: contacts.filter(
          (customer): customer is NonNullable<typeof customer> =>
            customer !== null
        ),
      },
      200
    );
  });

  app.openapi(getCompanyRoute, async (c) => {
    const { organizationId, companyId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const customer = await stub.getCustomer(companyId);
    if (!customer) {
      companyNotFound();
    }
    return c.json({ company: customerAsCompany(customer!) });
  });
}

/** Domain → workspace customer — find or create the org for a
 * contact's email domain. One company model: customers. */
async function ensureCustomerByDomain(
  env: WorkerEnv,
  organizationId: string,
  email: string
): Promise<string | null> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);
  const existing = await stub.getCustomerByDomain(domain);
  if (existing) return existing.id;
  const created = await stub.createCustomer({
    name: domain.replace(/\.[a-z]+$/, ""),
    url: `https://${domain}`,
    domain,
  });
  return created?.id ?? null;
}
