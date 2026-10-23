import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Buildings, Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { CompanyLogo } from "@/components/company-logo";
import { EntityHover } from "@/components/entity-hover";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

type SheetKey =
  | "all_active"
  | "trades"
  | "tech"
  | "partners_accounting"
  | "partners_vc"
  | "exploration"
  | "excluded_pos";

interface LeadClass {
  sheetKey: Exclude<SheetKey, "all_active">;
  categoryLabel: string;
  vortexWedge: string;
}

function classifyCustomerRow(row: {
  name?: string | null;
  vertical?: string | null;
  source?: string | null;
}): LeadClass {
  const v = (row.vertical ?? "").toLowerCase();
  const n = (row.name ?? "").toLowerCase();
  const s = (row.source ?? "").toLowerCase();

  if (
    v.includes("bookkeep") ||
    v.includes("cpa") ||
    v.includes("account") ||
    v.includes("tax") ||
    s.includes("bookkeep") ||
    s.includes("cpa") ||
    /\b(cpa|bookkeeping|accounting|tax service)\b/.test(n)
  ) {
    return {
      sheetKey: "partners_accounting",
      categoryLabel: "Bookkeeper / CPA Partner",
      vortexWedge: "Partner Residual Rev-Share",
    };
  }

  if (
    v.includes("venture") ||
    v.includes("capital partner") ||
    v.includes("accelerator") ||
    s.includes("venture") ||
    /\b(ventures|capital partners|venture partners|seed fund)\b/.test(n)
  ) {
    return {
      sheetKey: "partners_vc",
      categoryLabel: "VC / Fund Partner",
      vortexWedge: "Portfolio Startup Perks + Rev-Share",
    };
  }

  if (
    v.includes("tech") ||
    v.includes("software") ||
    v.includes("saas") ||
    s.includes("startup") ||
    /\b(technologies|software|ai labs|systems)\b/.test(n)
  ) {
    return {
      sheetKey: "tech",
      categoryLabel: "Tech / AI / SaaS Startup",
      vortexWedge: "Polar/Stripe Parity: SDKs + $10 ACH",
    };
  }

  if (
    v.includes("restaurant") ||
    v.includes("bar") ||
    v.includes("cafe") ||
    v.includes("bakery") ||
    v.includes("pizzeria") ||
    v.includes("deli") ||
    v.includes("nightclub") ||
    v.includes("excluded") ||
    /\b(pizzeria|osteria|bistro|taqueria|bakery|bagel|cafe|beer hall|delicatessen|grill|burrito|candy store)\b/.test(
      n
    )
  ) {
    return {
      sheetKey: "excluded_pos",
      categoryLabel: "Restaurant (POS Excluded)",
      vortexWedge: "Excluded — Requires Restaurant POS",
    };
  }

  if (v.includes("electrical")) {
    return {
      sheetKey: "trades",
      categoryLabel: "Electrical Contractor",
      vortexWedge: "Invoicing + $10 ACH + Surcharging",
    };
  }
  if (
    v.includes("plumber") ||
    v.includes("plumbing") ||
    v.includes("oil burner") ||
    v.includes("fire suppression") ||
    v === "mp"
  ) {
    return {
      sheetKey: "trades",
      categoryLabel: "Plumbing, Heating & Fire",
      vortexWedge: "Invoicing + $10 ACH + Surcharging",
    };
  }
  if (
    v.includes("filing representative") ||
    v.includes("special inspection") ||
    v.includes("engineering") ||
    v.includes("architect")
  ) {
    return {
      sheetKey: "trades",
      categoryLabel: "Architecture, Engineering & Expediting",
      vortexWedge: "Retainers + Milestone Invoices + $10 ACH",
    };
  }
  if (v.includes("license") || s.includes("trade waste") || s.includes("bic")) {
    return {
      sheetKey: "trades",
      categoryLabel: "Commercial Hauling & Demolition",
      vortexWedge: "Recurring B2B Invoices + ACH",
    };
  }
  if (
    v.includes("general contractor") ||
    v.includes("home improvement") ||
    v.includes("contractor") ||
    v.includes("rigger") ||
    v === "gc"
  ) {
    return {
      sheetKey: "trades",
      categoryLabel: "General & Home Improvement Contractor",
      vortexWedge: "Hosted Invoice + $10 ACH + Deposit Links",
    };
  }

  if (
    v.includes("garage") ||
    v.includes("auto") ||
    v.includes("tow") ||
    v.includes("car wash")
  ) {
    return {
      sheetKey: "exploration",
      categoryLabel: "Auto, Garage & Towing",
      vortexWedge: "Terminal + Surcharging + Text-to-Pay",
    };
  }
  if (
    v.includes("disabled") ||
    v.includes("medical") ||
    v.includes("dental") ||
    v.includes("pharmacy")
  ) {
    return {
      sheetKey: "exploration",
      categoryLabel: "Medical, Dental & DME",
      vortexWedge: "Payment Links + Card-on-File + Terminal",
    };
  }

  return {
    sheetKey: "exploration",
    categoryLabel: row.vertical || "B2B & Specialty SMB",
    vortexWedge: "Invoicing + Payment Links + ACH",
  };
}

const SHEET_DEFS: ReadonlyArray<{ key: SheetKey; label: string }> = [
  { key: "all_active", label: "All Active Leads" },
  { key: "trades", label: "Trades & Contractors (80%)" },
  { key: "tech", label: "Tech & Startups (80%)" },
  { key: "partners_accounting", label: "Partners: Bookkeepers & CPAs" },
  { key: "partners_vc", label: "Partners: VCs & Funds" },
  { key: "exploration", label: "Exploration SMBs (20%)" },
  { key: "excluded_pos", label: "Excluded (POS Restaurants)" },
];

/** Multi-sheet Notion/Google-Sheets style company table with category tabs,
 * sub-category filters, owner/Why-Now provenance, phone, and address columns. */
export function CustomersList() {
  const workspace = useWorkspace();
  const key = wsKey(workspace.id, "customers");
  const [activeSheet, setActiveSheet] = useState<SheetKey>("all_active");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const customers = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).customers,
  });

  const enrichedRows = useMemo(() => {
    const raw = customers.data ?? [];
    return raw.map((c) => {
      const extra = c as Record<string, unknown>;
      const classified = classifyCustomerRow({
        name: c.name,
        vertical: typeof extra.vertical === "string" ? extra.vertical : null,
        source: typeof extra.source === "string" ? extra.source : null,
      });
      return {
        raw: c,
        phone: typeof extra.phone === "string" ? extra.phone : null,
        address: typeof extra.address === "string" ? extra.address : null,
        neighborhood:
          typeof extra.neighborhood === "string" ? extra.neighborhood : null,
        signal: typeof extra.signal === "string" ? extra.signal : null,
        priorityScore:
          typeof extra.priorityScore === "number" ? extra.priorityScore : null,
        fitScore: typeof extra.fitScore === "number" ? extra.fitScore : null,
        fitStatus: typeof extra.fitStatus === "string" ? extra.fitStatus : null,
        classified,
      };
    });
  }, [customers.data]);

  const sheetCounts = useMemo(() => {
    const counts: Record<SheetKey, number> = {
      all_active: 0,
      trades: 0,
      tech: 0,
      partners_accounting: 0,
      partners_vc: 0,
      exploration: 0,
      excluded_pos: 0,
    };
    for (const r of enrichedRows) {
      counts[r.classified.sheetKey] += 1;
      if (r.classified.sheetKey !== "excluded_pos") {
        counts.all_active += 1;
      }
    }
    return counts;
  }, [enrichedRows]);

  const sheetFiltered = useMemo(() => {
    return enrichedRows.filter((r) => {
      if (activeSheet === "all_active") {
        return r.classified.sheetKey !== "excluded_pos";
      }
      return r.classified.sheetKey === activeSheet;
    });
  }, [enrichedRows, activeSheet]);

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of sheetFiltered) {
      counts.set(
        r.classified.categoryLabel,
        (counts.get(r.classified.categoryLabel) ?? 0) + 1
      );
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [sheetFiltered]);

  const visibleRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sheetFiltered
      .filter((r) => {
        if (
          selectedCategory !== "all" &&
          r.classified.categoryLabel !== selectedCategory
        ) {
          return false;
        }
        if (!q) return true;
        return (
          r.raw.name.toLowerCase().includes(q) ||
          r.classified.categoryLabel.toLowerCase().includes(q) ||
          (r.phone ?? "").toLowerCase().includes(q) ||
          (r.address ?? "").toLowerCase().includes(q) ||
          (r.neighborhood ?? "").toLowerCase().includes(q) ||
          (r.signal ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  }, [sheetFiltered, selectedCategory, searchQuery]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={SHEET_DEFS.map((s) => ({
            value: s.key,
            label: `${s.label} (${sheetCounts[s.key]})`,
          }))}
          value={activeSheet}
          onValueChange={(v) => {
            setActiveSheet(v as SheetKey);
            setSelectedCategory("all");
          }}
        />
        <div className="flex items-center gap-2">
          <Input
            placeholder="Filter by name, category, owner, phone, borough…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus />}
            onClick={() =>
              window.dispatchEvent(new CustomEvent("pile:create-customer"))
            }
          >
            Add company
          </Button>
        </div>
      </div>

      {categoryOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={selectedCategory === "all" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setSelectedCategory("all")}
          >
            All Categories ({sheetFiltered.length})
          </Button>
          {categoryOptions.map(([cat, cnt]) => (
            <Button
              key={cat}
              variant={selectedCategory === cat ? "primary" : "ghost"}
              size="sm"
              onClick={() => setSelectedCategory(cat)}
            >
              {cat} ({cnt})
            </Button>
          ))}
        </div>
      )}

      {customers.isPending ? (
        <LoadingState label="Loading companies" />
      ) : customers.isError ? (
        <ErrorState
          error={customers.error}
          onRetry={() => void customers.refetch()}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon={<Buildings size={40} />}
          title="No leads in this sheet yet"
          description="Switch sheet tabs or pull a fresh batch of leads."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Companies">
            <Table.Header>
              <Table.Row>
                <Table.Head>Company</Table.Head>
                <Table.Head>Category & Wedge</Table.Head>
                <Table.Head>Phone</Table.Head>
                <Table.Head>Location</Table.Head>
                <Table.Head>Principal & Why Now</Table.Head>
                <Table.Head>Fit & Score</Table.Head>
                <Table.Head>Added</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visibleRows.map((row) => {
                const customer = row.raw;
                return (
                  <Table.Row key={customer.id}>
                    <Table.Cell>
                      <EntityHover
                        title={customer.name}
                        description={customer.url}
                      >
                        <Link
                          to="/$slug/customers/$customerId"
                          params={{
                            slug: workspace.slug,
                            customerId: customer.id,
                          }}
                          className="text-kumo-link hover:underline font-medium"
                        >
                          <span className="flex items-center gap-2">
                            <CompanyLogo
                              name={customer.name}
                              logoUrl={customer.logoUrl}
                              url={customer.url}
                            />
                            <span className="flex flex-col">
                              <span>{customer.name}</span>
                              {customer.domain && (
                                <span className="text-xs text-kumo-subtle">
                                  {customer.domain}
                                </span>
                              )}
                            </span>
                          </span>
                        </Link>
                      </EntityHover>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col gap-0.5">
                        <div>
                          <Badge variant="secondary">
                            {row.classified.categoryLabel}
                          </Badge>
                        </div>
                        <span className="text-xs text-kumo-subtle">
                          {row.classified.vortexWedge}
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      {row.phone ? (
                        <a
                          href={`tel:${row.phone}`}
                          className="text-kumo-link hover:underline font-mono text-xs"
                        >
                          {row.phone}
                        </a>
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col text-xs">
                        {row.neighborhood && (
                          <span className="font-medium">
                            {row.neighborhood}
                          </span>
                        )}
                        <span className="text-kumo-subtle truncate max-w-[220px]">
                          {row.address ?? "—"}
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="text-xs text-kumo-subtle line-clamp-2 max-w-[280px]">
                        {row.signal ?? "—"}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {row.fitScore != null || row.priorityScore != null ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <Badge
                            variant={
                              row.fitStatus === "great"
                                ? "primary"
                                : "secondary"
                            }
                          >
                            Fit {row.fitScore ?? "—"}
                          </Badge>
                          {row.priorityScore != null && (
                            <span className="text-kumo-subtle font-mono">
                              P{row.priorityScore}
                            </span>
                          )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {formatRelative(customer.createdAt)}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </div>
  );
}
