import { and, asc, eq, gt, like, or, type SQL } from "drizzle-orm";

import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import {
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
  emailOptOut: boolean;
  emailOptOutAt: string | null;
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
  name: string | null;
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
    emailOptOut: false,
    emailOptOutAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function setEmailOptOutByEmail(
  db: D1Client,
  organizationId: string,
  email: string,
  optOut: boolean
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const now = new Date().toISOString();
  const rows = await db
    .update(supportCustomers)
    .set({
      emailOptOut: optOut,
      emailOptOutAt: optOut ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.email, normalized)
      )
    )
    .returning({ id: supportCustomers.id });
  return rows.length > 0;
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

export async function getCustomerByEmail(
  db: D1Client,
  organizationId: string,
  email: string
): Promise<SupportCustomer | null> {
  const normalizedEmail = email.toLowerCase().trim();
  const [customer] = await db
    .select()
    .from(supportCustomers)
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.email, normalizedEmail)
      )
    )
    .limit(1);
  return customer ?? null;
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
      .select()
      .from(supportCustomerCompanies)
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
      name: c.companyName,
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
  const conditions: (SQL<unknown> | undefined)[] = [
    eq(supportCustomers.organizationId, organizationId),
  ];

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
  > & { emailOptOut?: boolean }
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
      ...(input.emailOptOut !== undefined && {
        emailOptOut: input.emailOptOut,
        emailOptOutAt: input.emailOptOut ? now : null,
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

export async function setCustomerCompanies(
  db: D1Client,
  organizationId: string,
  customerId: string,
  companies: { companyId: string; isPrimary: boolean }[],
  env?: WorkerEnv
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
    // Names denormalize at write time — the join reads without
    // touching the workspace DO. Resolved via the stub when env is
    // present; falls back to null (the name renders as the id until
    // the next set call refreshes it).
    let names = new Map<string, string>();
    if (env) {
      const { getWorkspaceStub } = await import("../api/stub.js");
      const stub = getWorkspaceStub(env, organizationId);
      await stub.setOrganizationId(organizationId);
      const rows = await Promise.all(
        companies.map(async (c) => {
          const customer = await stub
            .getCustomer(c.companyId)
            .catch(() => null);
          return [c.companyId, customer?.name ?? null] as const;
        })
      );
      names = new Map(rows.filter((r): r is [string, string] => r[1] !== null));
    }

    await db.insert(supportCustomerCompanies).values(
      companies.map((c) => ({
        id: crypto.randomUUID(),
        customerId,
        companyId: c.companyId,
        companyName: names.get(c.companyId) ?? null,
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

/** The single company model — workspace customers. Migration
 * adapters call this with the workspace stub; it returns the
 * customer-shaped company row. */
export async function findOrCreateCompany(
  stub: {
    getCustomerByDomain(
      domain: string
    ): Promise<{ id: string; name: string; domain: string | null } | undefined>;
    createCustomer(input: {
      name: string;
      domain?: string | null;
      externalId?: string | null;
    }): Promise<{ id: string; name: string; domain: string | null }>;
  },
  organizationId: string,
  input: {
    name: string;
    domain?: string | null;
    externalId?: string | null;
    externalSource?: string;
  }
): Promise<{ id: string; name: string; domain: string | null }> {
  if (input.domain) {
    const existing = await stub.getCustomerByDomain(input.domain);
    if (existing) return existing;
  }
  return stub.createCustomer({
    name: input.name,
    domain: input.domain ?? null,
    externalId: input.externalId ?? null,
  });
}
