import { and, asc, eq, gt, like, or } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  supportCompanies,
  supportCustomerCompanies,
  supportCustomerIdentities,
  supportCustomers,
} from "./schema.js";

export type SupportCustomerInput = {
  id?: string;
  organizationId: string;
  email: string;
  fullName?: string | null;
  phone?: string | null;
  userId?: string | null;
  externalId?: string | null;
  externalSource?: string;
};

export type SupportCustomer = {
  id: string;
  organizationId: string;
  userId: string | null;
  externalId: string | null;
  externalSource: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportCustomerWithRelations = SupportCustomer & {
  companies: SupportCustomerCompany[];
  identities: SupportCustomerIdentity[];
};

export type SupportCustomerCompany = {
  id: string;
  customerId: string;
  companyId: string;
  name: string;
  isPrimary: boolean;
  createdAt: string;
};

export type SupportCustomerIdentityType =
  | "email"
  | "phone"
  | "slack"
  | "msteams"
  | "discord"
  | "whatsapp"
  | "chat"
  | "api"
  | "social"
  | "custom";

export type SupportCustomerIdentity = {
  id: string;
  customerId: string;
  type: SupportCustomerIdentityType;
  subType: string | null;
  value: string;
  isPrimary: boolean;
  createdAt: string;
};

export type SupportCompanyInput = {
  id?: string;
  organizationId: string;
  name: string;
  domain?: string | null;
  externalId?: string | null;
  externalSource?: string;
};

export type SupportCompany = {
  id: string;
  organizationId: string;
  name: string;
  domain: string | null;
  externalId: string | null;
  externalSource: string;
  createdAt: string;
  updatedAt: string;
};

function domainFromEmail(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : undefined;
}

export async function createCustomer(
  db: D1Client,
  input: SupportCustomerInput
): Promise<SupportCustomer> {
  const id = input.id ?? crypto.randomUUID();
  const externalSource = input.externalSource ?? "manual";
  const now = new Date().toISOString();

  await db.insert(supportCustomers).values({
    id,
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    externalId: input.externalId ?? null,
    externalSource,
    email: input.email,
    fullName: input.fullName ?? null,
    phone: input.phone ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    externalId: input.externalId ?? null,
    externalSource,
    email: input.email,
    fullName: input.fullName ?? null,
    phone: input.phone ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function findOrCreateCustomerByEmail(
  db: D1Client,
  organizationId: string,
  email: string,
  fullName?: string | null,
  externalSource?: string
): Promise<SupportCustomer> {
  const normalizedEmail = email.toLowerCase().trim();
  const [existing] = await db
    .select()
    .from(supportCustomers)
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.email, normalizedEmail)
      )
    )
    .limit(1);
  if (existing) {
    return existing;
  }
  return createCustomer(db, {
    organizationId,
    email: normalizedEmail,
    fullName,
    externalSource: externalSource ?? "email",
  });
}

export async function findCustomerByExternalId(
  db: D1Client,
  organizationId: string,
  externalId: string,
  externalSource: string
): Promise<SupportCustomer | null> {
  const [customer] = await db
    .select()
    .from(supportCustomers)
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.externalId, externalId),
        eq(supportCustomers.externalSource, externalSource)
      )
    )
    .limit(1);
  return customer ?? null;
}

export async function getCustomerById(
  db: D1Client,
  organizationId: string,
  id: string
): Promise<SupportCustomerWithRelations | null> {
  const [customer] = await db
    .select()
    .from(supportCustomers)
    .where(
      and(
        eq(supportCustomers.id, id),
        eq(supportCustomers.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!customer) {
    return null;
  }

  const [companies, identities] = await Promise.all([
    db
      .select({
        id: supportCustomerCompanies.id,
        customerId: supportCustomerCompanies.customerId,
        companyId: supportCustomerCompanies.companyId,
        name: supportCompanies.name,
        isPrimary: supportCustomerCompanies.isPrimary,
        createdAt: supportCustomerCompanies.createdAt,
      })
      .from(supportCustomerCompanies)
      .innerJoin(
        supportCompanies,
        eq(supportCustomerCompanies.companyId, supportCompanies.id)
      )
      .where(eq(supportCustomerCompanies.customerId, id)),
    db
      .select()
      .from(supportCustomerIdentities)
      .where(eq(supportCustomerIdentities.customerId, id)),
  ]);

  return {
    ...customer,
    companies: companies.map((c) => ({
      id: c.id,
      customerId: c.customerId,
      companyId: c.companyId,
      name: c.name,
      isPrimary: c.isPrimary,
      createdAt: c.createdAt,
    })),
    identities,
  };
}

export type ListCustomersOptions = {
  limit: number;
  cursor?: string;
  companyId?: string;
  q?: string;
};

export async function listCustomers(
  db: D1Client,
  organizationId: string,
  options: ListCustomersOptions
): Promise<{ customers: SupportCustomer[]; nextCursor: string | null }> {
  const conditions = [eq(supportCustomers.organizationId, organizationId)];

  if (options.companyId) {
    const customerIds = await db
      .select({ customerId: supportCustomerCompanies.customerId })
      .from(supportCustomerCompanies)
      .where(eq(supportCustomerCompanies.companyId, options.companyId));

    if (customerIds.length === 0) {
      return { customers: [], nextCursor: null };
    }

    conditions.push(
      or(...customerIds.map((c) => eq(supportCustomers.id, c.customerId)))
    );
  }

  if (options.q) {
    const query = `%${options.q}%`;
    conditions.push(
      or(
        like(supportCustomers.email, query),
        like(supportCustomers.fullName, query)
      )
    );
  }

  if (options.cursor) {
    conditions.push(gt(supportCustomers.createdAt, options.cursor));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const limit = Math.max(1, Math.min(options.limit, 100));

  const customers = await db
    .select()
    .from(supportCustomers)
    .where(where)
    .orderBy(asc(supportCustomers.createdAt))
    .limit(limit + 1);

  const hasMore = customers.length > limit;
  const sliced = hasMore ? customers.slice(0, -1) : customers;
  const nextCursor = hasMore ? sliced[sliced.length - 1].createdAt : null;

  return { customers: sliced, nextCursor };
}

export async function updateCustomer(
  db: D1Client,
  organizationId: string,
  id: string,
  input: Partial<
    Pick<
      SupportCustomerInput,
      | "email"
      | "fullName"
      | "phone"
      | "userId"
      | "externalId"
      | "externalSource"
    >
  >
): Promise<SupportCustomer | null> {
  const existing = await getCustomerById(db, organizationId, id);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();

  await db
    .update(supportCustomers)
    .set({
      ...(input.email !== undefined && { email: input.email }),
      ...(input.fullName !== undefined && { fullName: input.fullName ?? null }),
      ...(input.phone !== undefined && { phone: input.phone ?? null }),
      ...(input.userId !== undefined && { userId: input.userId ?? null }),
      ...(input.externalId !== undefined && {
        externalId: input.externalId ?? null,
      }),
      ...(input.externalSource !== undefined && {
        externalSource: input.externalSource,
      }),
      updatedAt: now,
    })
    .where(
      and(
        eq(supportCustomers.id, id),
        eq(supportCustomers.organizationId, organizationId)
      )
    );

  const updated = await getCustomerById(db, organizationId, id);
  return updated;
}

export async function resolveCompanyByDomain(
  db: D1Client,
  organizationId: string,
  email: string
): Promise<string | null> {
  const domain = domainFromEmail(email);
  if (!domain) {
    return null;
  }

  const [company] = await db
    .select({ id: supportCompanies.id })
    .from(supportCompanies)
    .where(
      and(
        eq(supportCompanies.organizationId, organizationId),
        eq(supportCompanies.domain, domain)
      )
    )
    .limit(1);

  return company?.id ?? null;
}

export async function setCustomerCompanies(
  db: D1Client,
  organizationId: string,
  customerId: string,
  companies: { companyId: string; isPrimary: boolean }[]
): Promise<void> {
  const customer = await getCustomerById(db, organizationId, customerId);
  if (!customer) {
    return;
  }

  await db
    .delete(supportCustomerCompanies)
    .where(eq(supportCustomerCompanies.customerId, customerId));

  if (companies.length > 0) {
    const now = new Date().toISOString();
    await db.insert(supportCustomerCompanies).values(
      companies.map((c) => ({
        id: crypto.randomUUID(),
        customerId,
        companyId: c.companyId,
        isPrimary: c.isPrimary,
        createdAt: now,
      }))
    );
  }
}

export type CustomerIdentityInput = {
  type: SupportCustomerIdentityType;
  subType?: string | null;
  value: string;
  isPrimary: boolean;
};

export async function setCustomerIdentities(
  db: D1Client,
  organizationId: string,
  customerId: string,
  identities: CustomerIdentityInput[]
): Promise<void> {
  const customer = await getCustomerById(db, organizationId, customerId);
  if (!customer) {
    return;
  }

  await db
    .delete(supportCustomerIdentities)
    .where(eq(supportCustomerIdentities.customerId, customerId));

  if (identities.length > 0) {
    const now = new Date().toISOString();
    await db.insert(supportCustomerIdentities).values(
      identities.map((i) => ({
        id: crypto.randomUUID(),
        customerId,
        type: i.type,
        subType: i.subType ?? null,
        value: i.value,
        isPrimary: i.isPrimary,
        createdAt: now,
      }))
    );
  }
}

export async function createCompany(
  db: D1Client,
  input: SupportCompanyInput
): Promise<SupportCompany> {
  const id = input.id ?? crypto.randomUUID();
  const externalSource = input.externalSource ?? "manual";
  const now = new Date().toISOString();

  await db.insert(supportCompanies).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    domain: input.domain ?? null,
    externalId: input.externalId ?? null,
    externalSource,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: input.organizationId,
    name: input.name,
    domain: input.domain ?? null,
    externalId: input.externalId ?? null,
    externalSource,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getCompanyById(
  db: D1Client,
  organizationId: string,
  id: string
): Promise<SupportCompany | null> {
  const [company] = await db
    .select()
    .from(supportCompanies)
    .where(
      and(
        eq(supportCompanies.id, id),
        eq(supportCompanies.organizationId, organizationId)
      )
    )
    .limit(1);

  return company ?? null;
}

export async function findCompanyByExternalId(
  db: D1Client,
  organizationId: string,
  externalId: string,
  externalSource: string
): Promise<SupportCompany | null> {
  const [company] = await db
    .select()
    .from(supportCompanies)
    .where(
      and(
        eq(supportCompanies.organizationId, organizationId),
        eq(supportCompanies.externalId, externalId),
        eq(supportCompanies.externalSource, externalSource)
      )
    )
    .limit(1);
  return company ?? null;
}

export async function findOrCreateCompany(
  db: D1Client,
  organizationId: string,
  input: SupportCompanyInput
): Promise<SupportCompany> {
  if (input.externalId && input.externalSource) {
    const existing = await findCompanyByExternalId(
      db,
      organizationId,
      input.externalId,
      input.externalSource
    );
    if (existing) return existing;
  }
  return createCompany(db, input);
}

export type ListCompaniesOptions = {
  limit: number;
  cursor?: string;
  q?: string;
};

export async function listCompanies(
  db: D1Client,
  organizationId: string,
  options: ListCompaniesOptions
): Promise<{ companies: SupportCompany[]; nextCursor: string | null }> {
  const conditions = [eq(supportCompanies.organizationId, organizationId)];

  if (options.q) {
    const query = `%${options.q}%`;
    conditions.push(
      or(
        like(supportCompanies.name, query),
        like(supportCompanies.domain, query)
      )
    );
  }

  if (options.cursor) {
    conditions.push(gt(supportCompanies.createdAt, options.cursor));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const limit = Math.max(1, Math.min(options.limit, 100));

  const companies = await db
    .select()
    .from(supportCompanies)
    .where(where)
    .orderBy(asc(supportCompanies.createdAt))
    .limit(limit + 1);

  const hasMore = companies.length > limit;
  const sliced = hasMore ? companies.slice(0, -1) : companies;
  const nextCursor = hasMore ? sliced[sliced.length - 1].createdAt : null;

  return { companies: sliced, nextCursor };
}
