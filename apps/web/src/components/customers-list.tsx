import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Buildings, Plus, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { CompanyLogo } from "@/components/company-logo";
import { EntityHover } from "@/components/entity-hover";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

type SheetKey =
  | "all_active"
  | "trades"
  | "tech"
  | "partners_accounting"
  | "partners_vc"
  | "exploration"
  | "excluded_pos";

type SortField = "score" | "name" | "category" | "owner" | "location" | "added";

interface LeadClass {
  sheetKey: Exclude<SheetKey, "all_active">;
  categoryLabel: string;
  vortexWedge: string;
}

const KNOWN_OWNERS: Record<string, string> = {
  "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE": "Shlomo",
  ecH8c2QyUL9IldR7F59YLtvG58s76UIh: "Ronny",
};

const OWNER_SELECT_OPTIONS = [
  { id: "", label: "Unassigned" },
  { id: "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE", label: "Shlomo" },
  { id: "ecH8c2QyUL9IldR7F59YLtvG58s76UIh", label: "Ronny" },
] as const;

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

const SHEET_DEFS: ReadonlyArray<{
  key: SheetKey;
  label: string;
  defaultPreset:
    | "nyc_dob_contractors_and_trades"
    | "nyc_tech_and_software_startups"
    | "nyc_bookkeepers_and_cpas"
    | "nyc_vc_and_accelerators"
    | "nyc_auto_and_garages";
}> = [
  {
    key: "all_active",
    label: "All Active",
    defaultPreset: "nyc_dob_contractors_and_trades",
  },
  {
    key: "trades",
    label: "Trades & Contractors",
    defaultPreset: "nyc_dob_contractors_and_trades",
  },
  {
    key: "tech",
    label: "Tech & Startups",
    defaultPreset: "nyc_tech_and_software_startups",
  },
  {
    key: "partners_accounting",
    label: "Partners: Bookkeepers & CPAs",
    defaultPreset: "nyc_bookkeepers_and_cpas",
  },
  {
    key: "partners_vc",
    label: "Partners: VCs & Funds",
    defaultPreset: "nyc_vc_and_accelerators",
  },
  {
    key: "exploration",
    label: "Exploration SMBs (20%)",
    defaultPreset: "nyc_auto_and_garages",
  },
  {
    key: "excluded_pos",
    label: "Excluded (POS)",
    defaultPreset: "nyc_dob_contractors_and_trades",
  },
];

/** Notion Database / Google Sheets / Linear style dense tabular view with
 * Side Peek drawer, inline Owner assignment, sortable columns, and CSV export. */
export function CustomersList() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const key = wsKey(workspace.id, "customers");
  const [activeSheet, setActiveSheet] = useState<SheetKey>("all_active");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedOwner, setSelectedOwner] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortField, setSortField] = useState<SortField>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [peekRowId, setPeekRowId] = useState<string | null>(null);

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

  const patchOwner = useMutation({
    mutationFn: async (input: {
      customerId: string;
      ownerId: string | undefined;
    }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/customers/{id}", {
          params: {
            path: { organizationId: workspace.id, id: input.customerId },
          },
          body: { ownerId: input.ownerId },
        })
      ),
    onSuccess: () => {
      toastSuccess("Owner updated");
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toastError(err, "Could not update owner"),
  });

  const pullLeadsMutation = useMutation({
    mutationFn: async () => {
      const sheetDef =
        SHEET_DEFS.find((s) => s.key === activeSheet) ?? SHEET_DEFS[0]!;
      return unwrap(
        api.POST("/workspaces/{organizationId}/customers/pull-leads", {
          params: { path: { organizationId: workspace.id } },
          body: {
            preset: sheetDef.defaultPreset,
            limit: 10,
            enrichWebsites: true,
            dispatchDetectiveBatch: false,
          },
        })
      );
    },
    onSuccess: (res) => {
      toastSuccess(
        `Pulled ${res.pulledCount} leads (${res.createdCount} new, ${res.updatedCount} updated)`
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toastError(err, "Could not pull leads"),
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
        evidenceUri:
          typeof extra.evidenceUri === "string" ? extra.evidenceUri : null,
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
    const filtered = sheetFiltered.filter((r) => {
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
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortField === "name") {
        return a.raw.name.localeCompare(b.raw.name) * dir;
      }
      if (sortField === "category") {
        return (
          a.classified.categoryLabel.localeCompare(b.classified.categoryLabel) *
          dir
        );
      }
      if (sortField === "owner") {
        return a.ownerName.localeCompare(b.ownerName) * dir;
      }
      if (sortField === "location") {
        return (
          (a.neighborhood ?? a.address ?? "").localeCompare(
            b.neighborhood ?? b.address ?? ""
          ) * dir
        );
      }
      if (sortField === "added") {
        return a.raw.createdAt.localeCompare(b.raw.createdAt) * dir;
      }
      return ((a.priorityScore ?? 0) - (b.priorityScore ?? 0)) * dir;
    });
  }, [sheetFiltered, selectedCategory, searchQuery, sortField, sortDir]);

  const peekRow = useMemo(
    () => enrichedRows.find((r) => r.raw.id === peekRowId) ?? null,
    [enrichedRows, peekRowId]
  );

  const peekContacts = useQuery({
    queryKey: wsKey(
      workspace.id,
      "customer-lead-contacts",
      peekRowId ?? "none"
    ),
    enabled: Boolean(peekRowId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers/{id}/contacts", {
            params: {
              path: {
                organizationId: workspace.id,
                id: peekRowId!,
              },
            },
          })
        )
      ).contacts,
  });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "score" || field === "added" ? "desc" : "asc");
    }
  }

  function exportCsv() {
    const headers = [
      "Name",
      "Category",
      "Wedge",
      "Owner",
      "Phone",
      "Domain",
      "Borough",
      "Address",
      "Signal",
      "FitScore",
      "PriorityScore",
    ];
    const lines = [
      headers.join(","),
      ...visibleRows.map((r) =>
        [
          r.raw.name,
          r.classified.categoryLabel,
          r.classified.vortexWedge,
          r.ownerName,
          r.phone ?? "",
          r.raw.domain ?? "",
          r.neighborhood ?? "",
          r.address ?? "",
          r.signal ?? "",
          String(r.fitScore ?? ""),
          String(r.priorityScore ?? ""),
        ]
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pile-${activeSheet}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
        <div className="flex flex-wrap items-center gap-2">
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
            variant="secondary"
            size="sm"
            loading={pullLeadsMutation.isPending}
            onClick={() => pullLeadsMutation.mutate()}
          >
            Pull +10 Leads
          </Button>
          <Button variant="ghost" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
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

      {/* Main Content + Optional Notion Side Peek Drawer */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
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
                  <tr className="border-b border-kumo-line bg-kumo-tint/30 text-[11px] font-medium uppercase tracking-wider text-kumo-subtle select-none">
                    <th className="w-10 border-r border-kumo-line px-2 py-1.5 text-right font-mono">
                      #
                    </th>
                    <th
                      onClick={() => toggleSort("name")}
                      className="min-w-[220px] cursor-pointer border-r border-kumo-line px-2.5 py-1.5 hover:text-kumo-default"
                    >
                      Company{" "}
                      {sortField === "name"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                    <th
                      onClick={() => toggleSort("category")}
                      className="min-w-[180px] cursor-pointer border-r border-kumo-line px-2.5 py-1.5 hover:text-kumo-default"
                    >
                      Category{" "}
                      {sortField === "category"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                    <th
                      onClick={() => toggleSort("owner")}
                      className="min-w-[100px] cursor-pointer border-r border-kumo-line px-2.5 py-1.5 hover:text-kumo-default"
                    >
                      Owner{" "}
                      {sortField === "owner"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                    <th className="min-w-[125px] border-r border-kumo-line px-2.5 py-1.5">
                      Phone
                    </th>
                    <th
                      onClick={() => toggleSort("location")}
                      className="min-w-[220px] cursor-pointer border-r border-kumo-line px-2.5 py-1.5 hover:text-kumo-default"
                    >
                      Location{" "}
                      {sortField === "location"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                    <th className="min-w-[260px] border-r border-kumo-line px-2.5 py-1.5">
                      Principal & Signal
                    </th>
                    <th
                      onClick={() => toggleSort("score")}
                      className="min-w-[90px] cursor-pointer border-r border-kumo-line px-2.5 py-1.5 hover:text-kumo-default"
                    >
                      Score{" "}
                      {sortField === "score"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                    <th
                      onClick={() => toggleSort("added")}
                      className="w-24 cursor-pointer px-2.5 py-1.5 hover:text-kumo-default"
                    >
                      Added{" "}
                      {sortField === "added"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, idx) => {
                    const customer = row.raw;
                    const isPeeked = peekRowId === customer.id;
                    return (
                      <tr
                        key={customer.id}
                        onClick={() => setPeekRowId(customer.id)}
                        className={`cursor-pointer border-b border-kumo-line transition-colors ${
                          isPeeked ? "bg-kumo-tint/40" : "hover:bg-kumo-tint/20"
                        }`}
                      >
                        <td className="border-r border-kumo-line px-2 py-1.5 text-right font-mono text-[11px] text-kumo-subtle">
                          {idx + 1}
                        </td>
                        <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap">
                          <div className="flex items-center justify-between gap-2">
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
                                onClick={(e) => e.stopPropagation()}
                                className="text-kumo-link hover:underline font-medium inline-flex items-center gap-1.5"
                              >
                                <CompanyLogo
                                  name={customer.name}
                                  logoUrl={customer.logoUrl}
                                  url={customer.url}
                                />
                                <span className="truncate max-w-[190px]">
                                  {customer.name}
                                </span>
                                {customer.domain && (
                                  <span className="text-[11px] text-kumo-subtle font-normal">
                                    · {customer.domain}
                                  </span>
                                )}
                              </Link>
                            </EntityHover>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPeekRowId(isPeeked ? null : customer.id);
                              }}
                              className="rounded border border-kumo-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-kumo-subtle hover:text-kumo-default"
                            >
                              Peek
                            </button>
                          </div>
                        </td>
                        <td className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap">
                          <Badge variant="secondary">
                            {row.classified.categoryLabel}
                          </Badge>
                        </td>
                        <td
                          onClick={(e) => e.stopPropagation()}
                          className="border-r border-kumo-line px-2 py-1 whitespace-nowrap"
                        >
                          <select
                            aria-label={`Owner for ${customer.name}`}
                            value={row.ownerId ?? ""}
                            onChange={(e) =>
                              patchOwner.mutate({
                                customerId: customer.id,
                                ownerId: e.target.value || undefined,
                              })
                            }
                            className="h-6 rounded border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
                          >
                            {OWNER_SELECT_OPTIONS.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td
                          onClick={(e) => e.stopPropagation()}
                          className="border-r border-kumo-line px-2.5 py-1.5 whitespace-nowrap font-mono"
                        >
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
                              F{row.fitScore ?? "—"} · P
                              {row.priorityScore ?? "—"}
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

        {/* Notion-Style Side Peek Drawer */}
        {peekRow && (
          <div className="w-96 shrink-0 rounded border border-kumo-line bg-kumo-base p-4 text-xs shadow-sm">
            <div className="flex items-start justify-between gap-2 border-b border-kumo-line pb-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold text-kumo-default">
                  {peekRow.raw.name}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">
                    {peekRow.classified.categoryLabel}
                  </Badge>
                  <Badge variant="primary">{peekRow.ownerName}</Badge>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPeekRowId(null)}
                className="rounded p-1 text-kumo-subtle hover:text-kumo-default"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-3 flex flex-col gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-kumo-subtle">
                  Vortex Wedge
                </div>
                <div className="mt-0.5 font-medium text-kumo-default">
                  {peekRow.classified.vortexWedge}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-kumo-subtle">
                  Phone & Address
                </div>
                <div className="mt-0.5 font-mono text-sm">
                  {peekRow.phone ? (
                    <a
                      href={`tel:${peekRow.phone}`}
                      className="text-kumo-link hover:underline"
                    >
                      {peekRow.phone}
                    </a>
                  ) : (
                    <span className="text-kumo-subtle">No phone</span>
                  )}
                </div>
                <div className="mt-0.5 text-kumo-default">
                  {peekRow.address ?? "No address"}
                  {peekRow.address && (
                    <>
                      {" · "}
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(peekRow.address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-kumo-link hover:underline"
                      >
                        Maps ↗
                      </a>
                    </>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-kumo-subtle">
                  Principal Contacts ({(peekContacts.data ?? []).length})
                </div>
                {(peekContacts.data ?? []).length === 0 ? (
                  <div className="mt-1 text-kumo-subtle">
                    {peekContacts.isPending
                      ? "Loading contacts…"
                      : "No separate contact rows"}
                  </div>
                ) : (
                  <div className="mt-1 flex flex-col gap-1.5">
                    {(peekContacts.data ?? []).map((ct) => (
                      <div
                        key={ct.id}
                        className="flex items-center justify-between gap-2 rounded border border-kumo-line px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-kumo-default truncate">
                            {ct.label ?? peekRow.raw.name}
                          </div>
                          <div className="font-mono text-[11px] text-kumo-link truncate">
                            {ct.channel === "email" ? (
                              <a href={`mailto:${ct.value}`}>{ct.value}</a>
                            ) : ct.channel === "phone" ? (
                              <a href={`tel:${ct.value}`}>{ct.value}</a>
                            ) : (
                              ct.value
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(ct.value);
                            toastSuccess(`Copied ${ct.value}`);
                          }}
                          className="shrink-0 rounded border border-kumo-line px-1.5 py-0.5 text-[10px] text-kumo-subtle hover:text-kumo-default"
                        >
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-kumo-subtle">
                  Why Now & Registry Evidence
                </div>
                <div className="mt-0.5 text-kumo-default">
                  {peekRow.signal ?? "—"}
                </div>
                {peekRow.evidenceUri && (
                  <a
                    href={peekRow.evidenceUri}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-0.5 inline-block text-kumo-link hover:underline"
                  >
                    Official Registry Filing ↗
                  </a>
                )}
              </div>

              <div className="border-t border-kumo-line pt-3">
                <Link
                  to="/$slug/customers/$customerId"
                  params={{
                    slug: workspace.slug,
                    customerId: peekRow.raw.id,
                  }}
                  className="text-kumo-link hover:underline font-medium"
                >
                  Open full record page →
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
