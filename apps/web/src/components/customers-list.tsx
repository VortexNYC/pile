import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
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

const KNOWN_OWNERS: Record<string, string> = {
  "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE": "Shlomo",
  ecH8c2QyUL9IldR7F59YLtvG58s76UIh: "Ronny",
};

function ownerDisplayName(ownerId: string | null | undefined): string {
  if (!ownerId) return "Unassigned";
  return KNOWN_OWNERS[ownerId] ?? ownerId.slice(0, 8);
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
  { key: "all_active", label: "All Active" },
  { key: "trades", label: "Trades & Contractors" },
  { key: "tech", label: "Tech & Startups" },
  { key: "partners_accounting", label: "Partners: Bookkeepers & CPAs" },
  { key: "partners_vc", label: "Partners: VCs & Funds" },
  { key: "exploration", label: "Exploration SMBs (20%)" },
  { key: "excluded_pos", label: "Excluded (POS)" },
];

/** Notion Database / Google Sheets / Linear style dense tabular view. */
export function CustomersList() {
  const workspace = useWorkspace();
  const key = wsKey(workspace.id, "customers");
  const [activeSheet, setActiveSheet] = useState<SheetKey>("all_active");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedOwner, setSelectedOwner] = useState<string>("all");
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
      const ownerId = typeof extra.ownerId === "string" ? extra.ownerId : null;
      return {
        raw: c,
        ownerId,
        ownerName: ownerDisplayName(ownerId),
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

  const ownerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of enrichedRows) {
      if (r.classified.sheetKey === "excluded_pos") continue;
      counts.set(r.ownerName, (counts.get(r.ownerName) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [enrichedRows]);

  const ownerFilteredRows = useMemo(() => {
    if (selectedOwner === "all") return enrichedRows;
    return enrichedRows.filter((r) => r.ownerName === selectedOwner);
  }, [enrichedRows, selectedOwner]);

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
    for (const r of ownerFilteredRows) {
      counts[r.classified.sheetKey] += 1;
      if (r.classified.sheetKey !== "excluded_pos") {
        counts.all_active += 1;
      }
    }
    return counts;
  }, [ownerFilteredRows]);

  const visibleSheets = useMemo(() => {
    return SHEET_DEFS.filter(
      (s) => s.key === "all_active" || sheetCounts[s.key] > 0
    );
  }, [sheetCounts]);

  const sheetFiltered = useMemo(() => {
    return ownerFilteredRows.filter((r) => {
      if (activeSheet === "all_active") {
        return r.classified.sheetKey !== "excluded_pos";
      }
      return r.classified.sheetKey === activeSheet;
    });
  }, [ownerFilteredRows, activeSheet]);

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
          r.ownerName.toLowerCase().includes(q) ||
          (r.phone ?? "").toLowerCase().includes(q) ||
          (r.address ?? "").toLowerCase().includes(q) ||
          (r.neighborhood ?? "").toLowerCase().includes(q) ||
          (r.signal ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  }, [sheetFiltered, selectedCategory, searchQuery]);

  return (
    <div className="flex flex-col gap-2">
      {/* Top Notion/Sheets View Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line pb-2">
        <Tabs
          tabs={visibleSheets.map((s) => ({
            value: s.key,
            label: `${s.label} · ${sheetCounts[s.key]}`,
          }))}
          value={activeSheet}
          onValueChange={(v) => {
            setActiveSheet(v as SheetKey);
            setSelectedCategory("all");
          }}
        />
        <div className="flex items-center gap-2">
          {ownerOptions.length > 1 && (
            <div className="flex items-center gap-1 rounded border border-kumo-line px-1 py-0.5 text-xs">
              <button
                type="button"
                onClick={() => setSelectedOwner("all")}
                className={`rounded px-2 py-0.5 ${
                  selectedOwner === "all"
                    ? "bg-kumo-tint font-medium text-kumo-default"
                    : "text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                All Owners
              </button>
              {ownerOptions.map(([owner, cnt]) => (
                <button
                  key={owner}
                  type="button"
                  onClick={() => setSelectedOwner(owner)}
                  className={`rounded px-2 py-0.5 ${
                    selectedOwner === owner
                      ? "bg-kumo-tint font-medium text-kumo-default"
                      : "text-kumo-subtle hover:text-kumo-default"
                  }`}
                >
                  {owner} ({cnt})
                </button>
              ))}
            </div>
          )}
          <Input
            placeholder="Filter rows…"
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
            New row
          </Button>
        </div>
      </div>

      {/* Sub-Category Filter Strip (Notion/Linear filter bar) */}
      {categoryOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-kumo-subtle mr-1">Category:</span>
          <button
            type="button"
            onClick={() => setSelectedCategory("all")}
            className={`rounded border px-2 py-0.5 transition-colors ${
              selectedCategory === "all"
                ? "border-kumo-default bg-kumo-tint font-medium text-kumo-default"
                : "border-kumo-line text-kumo-subtle hover:text-kumo-default"
            }`}
          >
            All ({sheetFiltered.length})
          </button>
          {categoryOptions.map(([cat, cnt]) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`rounded border px-2 py-0.5 transition-colors ${
                selectedCategory === cat
                  ? "border-kumo-default bg-kumo-tint font-medium text-kumo-default"
                  : "border-kumo-line text-kumo-subtle hover:text-kumo-default"
              }`}
            >
              {cat} · {cnt}
            </button>
          ))}
        </div>
      )}

      {/* Dense Spreadsheet / Notion Database Grid */}
      {customers.isPending ? (
        <LoadingState label="Loading sheet" />
      ) : customers.isError ? (
        <ErrorState
          error={customers.error}
          onRetry={() => void customers.refetch()}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon={<Buildings size={40} />}
          title="No rows match this view"
          description="Switch sheet tabs or clear active filters."
        />
      ) : (
        <div className="overflow-x-auto rounded border border-kumo-line bg-kumo-base">
          <table
            aria-label="Companies"
            className="w-full border-collapse text-left text-xs"
          >
            <thead>
              <tr className="border-b border-kumo-line bg-kumo-tint/30 text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">
                <th className="w-10 border-r border-kumo-line px-2 py-1.5 text-right font-mono">
                  #
                </th>
                <th className="min-w-[220px] border-r border-kumo-line px-2.5 py-1.5">
                  Company
                </th>
                <th className="min-w-[180px] border-r border-kumo-line px-2.5 py-1.5">
                  Category
                </th>
                <th className="min-w-[90px] border-r border-kumo-line px-2.5 py-1.5">
                  Owner
                </th>
                <th className="min-w-[125px] border-r border-kumo-line px-2.5 py-1.5">
                  Phone
                </th>
                <th className="min-w-[220px] border-r border-kumo-line px-2.5 py-1.5">
                  Location
                </th>
                <th className="min-w-[260px] border-r border-kumo-line px-2.5 py-1.5">
                  Principal & Signal
                </th>
                <th className="min-w-[90px] border-r border-kumo-line px-2.5 py-1.5">
                  Score
                </th>
                <th className="w-24 px-2.5 py-1.5">Added</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, idx) => {
                const customer = row.raw;
                return (
                  <tr
                    key={customer.id}
                    className="border-b border-kumo-line hover:bg-kumo-tint/20 transition-colors"
                  >
                    <td className="border-r border-kumo-line px-2 py-1.5 text-right font-mono text-[11px] text-kumo-subtle">
                      {idx + 1}
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap">
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
                          className="text-kumo-link hover:underline font-medium inline-flex items-center gap-1.5"
                        >
                          <CompanyLogo
                            name={customer.name}
                            logoUrl={customer.logoUrl}
                            url={customer.url}
                          />
                          <span className="truncate max-w-[210px]">
                            {customer.name}
                          </span>
                          {customer.domain && (
                            <span className="text-[11px] text-kumo-subtle font-normal">
                              · {customer.domain}
                            </span>
                          )}
                        </Link>
                      </EntityHover>
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap">
                      <Badge variant="secondary">
                        {row.classified.categoryLabel}
                      </Badge>
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap">
                      <Badge
                        variant={
                          row.ownerName === "Shlomo" ? "primary" : "secondary"
                        }
                      >
                        {row.ownerName}
                      </Badge>
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap font-mono">
                      {row.phone ? (
                        <a
                          href={`tel:${row.phone}`}
                          className="text-kumo-link hover:underline"
                        >
                          {row.phone}
                        </a>
                      ) : (
                        <span className="text-kumo-subtle">—</span>
                      )}
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap">
                      <span className="truncate block max-w-[230px] text-kumo-subtle">
                        {row.neighborhood ? `${row.neighborhood} · ` : ""}
                        {row.address ?? "—"}
                      </span>
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5">
                      <span className="truncate block max-w-[290px] text-kumo-subtle">
                        {row.signal ?? row.classified.vortexWedge}
                      </span>
                    </td>
                    <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap font-mono">
                      {row.fitScore != null || row.priorityScore != null ? (
                        <span>
                          F{row.fitScore ?? "—"} · P{row.priorityScore ?? "—"}
                        </span>
                      ) : (
                        <span className="text-kumo-subtle">—</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap text-kumo-subtle">
                      {formatRelative(customer.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
