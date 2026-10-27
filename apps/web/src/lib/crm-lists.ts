import { api, type paths, unwrap } from "@/lib/api";

/** PILE-653 — /customers and /deals are bounded list endpoints now: every
 *  response is a page of at most `limit` rows plus a `nextCursor`. These
 *  helpers follow the cursor so surfaces that genuinely need the whole set
 *  (the sheet, the pipeline) still get it — while pickers pass
 *  `summary: "1"` and stop paying for the heavy columns. */

export const CRM_LIST_PAGE_LIMIT = 500;

/** Follow `nextCursor` pages until the bounded endpoint runs dry. */
export async function collectPages<Row>(
  fetchPage: (
    cursor: string | undefined
  ) => Promise<{ rows: Row[]; nextCursor?: string }>
): Promise<Row[]> {
  const all: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

type CustomersPage =
  paths["/workspaces/{organizationId}/customers"]["get"]["responses"][200]["content"]["application/json"];

export type CustomerListRow = CustomersPage["customers"][number];

type DealsPage =
  paths["/workspaces/{organizationId}/deals"]["get"]["responses"][200]["content"]["application/json"];

export type DealListRow = DealsPage["deals"][number];

export async function fetchAllCustomers(options: {
  organizationId: string;
  summary?: boolean;
  q?: string;
  dueBefore?: string;
  limit?: number;
}): Promise<CustomerListRow[]> {
  return collectPages(async (cursor) => {
    const page = await unwrap(
      api.GET("/workspaces/{organizationId}/customers", {
        params: {
          path: { organizationId: options.organizationId },
          query: {
            limit: options.limit ?? CRM_LIST_PAGE_LIMIT,
            cursor,
            q: options.q,
            dueBefore: options.dueBefore,
            summary: options.summary ? "1" : undefined,
          },
        },
      })
    );
    return { rows: page.customers, nextCursor: page.nextCursor };
  });
}

export async function fetchAllDeals(options: {
  organizationId: string;
  summary?: boolean;
  q?: string;
  customerId?: string;
  contactId?: string;
  limit?: number;
}): Promise<DealListRow[]> {
  return collectPages(async (cursor) => {
    const page = await unwrap(
      api.GET("/workspaces/{organizationId}/deals", {
        params: {
          path: { organizationId: options.organizationId },
          query: {
            limit: options.limit ?? CRM_LIST_PAGE_LIMIT,
            cursor,
            q: options.q,
            customerId: options.customerId,
            contactId: options.contactId,
            summary: options.summary ? "1" : undefined,
          },
        },
      })
    );
    return { rows: page.deals, nextCursor: page.nextCursor };
  });
}
