import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Buildings, Plus, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { CompanyLogo } from "@/components/company-logo";
import {
  type CustomerColumnKey,
  CustomersDisplayMenu,
  densityClasses,
  isColumnVisible,
} from "@/components/customers-display-menu";
import { EntityHover } from "@/components/entity-hover";
import { LogTouchDialog } from "@/components/log-touch-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, stageGateBlockMessage, unwrap } from "@/lib/api";
import { orderedStages, stageColor, stageRowTint } from "@/lib/customer-stages";
import { isFollowUpOverdue } from "@/lib/follow-ups";
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

// PILE-645 — render window for the companies table.
export const PAGE_SIZE = 75;

/** Rows rendered in the current window (pagination by slicing). */
export function windowRows<T>(rows: ReadonlyArray<T>, limit: number): T[] {
  return rows.slice(0, limit);
}

const OWNER_SELECT_OPTIONS = [
  { id: "", label: "Unassigned" },
  { id: "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE", label: "Shlomo" },
  { id: "ecH8c2QyUL9IldR7F59YLtvG58s76UIh", label: "Ronny" },
] as const;

/** Shared with the Follow-ups tab — "Shlomo"/"Ronny" or a shortened id. */
export function ownerDisplayName(ownerId: string | null | undefined): string {
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

/** Count rows by a key selector and return [key, count] pairs ranked by
 * count descending — used for owner and category filter options. */
export function rankedCounts<K extends string>(
  keys: Iterable<K>
): Array<[K, number]> {
  const counts = new Map<K, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).toSorted((a, b) => b[1] - a[1]);
}

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
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  // PILE-645 — reset the render window when the sheet/owner/category
  // filter changes.
  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [activeSheet, selectedOwner, selectedCategory]);
  const deferredSearch = useDeferredValue(searchQuery);
  const [peekRowId, setPeekRowId] = useState<string | null>(null);
  // PILE-651 — the row a "Log touch" dialog is open for.
  const [logTouchTarget, setLogTouchTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Sheets-style display prefs — row density and column visibility —
  // persisted per user via me/view-preferences. Row color is the
  // customer's pipeline stage (customers.statusId), not a pref.
  const {
    prefs: displayPrefs,
    setDensity,
    toggleColumn,
  } = useDisplayPrefs(workspace.id, "customers");
  const density = displayPrefs.density ?? "comfortable";
  const densityCls = densityClasses(density);
  const hiddenColumns = displayPrefs.hiddenColumns;
  const columnVisible = (col: CustomerColumnKey) =>
    isColumnVisible(hiddenColumns, col);

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
    staleTime: 30_000,
  });

  // The pipeline stages (customer_statuses rows) — row color + the Stage
  // column's options both come from this workspace-owned list.
  const statuses = useQuery({
    queryKey: wsKey(workspace.id, "customer-statuses"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customer-statuses", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).statuses,
    staleTime: 30_000,
  });
  const statusById = useMemo(
    () => new Map((statuses.data ?? []).map((s) => [s.id, s])),
    [statuses.data]
  );
  const stageOptions = useMemo(
    () => orderedStages(statuses.data ?? []),
    [statuses.data]
  );

  const patchStage = useMutation({
    mutationFn: async (input: {
      customerId: string;
      statusId: string | null;
    }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/customers/{id}", {
          params: {
            path: { organizationId: workspace.id, id: input.customerId },
          },
          body: { statusId: input.statusId },
        })
      ),
    onSuccess: () => {
      toastSuccess("Stage updated");
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) =>
      toastError(err, stageGateBlockMessage(err) ?? "Could not update stage"),
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
        statusId: c.statusId,
        ownerName: ownerDisplayName(ownerId),
        nextStepText:
          typeof extra.nextStepText === "string" ? extra.nextStepText : null,
        nextStepDueAt:
          typeof extra.nextStepDueAt === "string" ? extra.nextStepDueAt : null,
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

  const ownerOptions = useMemo(
    () =>
      rankedCounts(
        enrichedRows
          .filter((r) => r.classified.sheetKey !== "excluded_pos")
          .map((r) => r.ownerName)
      ),
    [enrichedRows]
  );

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

  const categoryOptions = useMemo(
    () => rankedCounts(sheetFiltered.map((r) => r.classified.categoryLabel)),
    [sheetFiltered]
  );

  const visibleRows = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
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
    return [...filtered].toSorted((a, b) => {
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
  }, [sheetFiltered, selectedCategory, deferredSearch, sortField, sortDir]);

  const renderedRows = windowRows(visibleRows, visibleLimit);

  const peekRow = useMemo(
    () => enrichedRows.find((r) => r.raw.id === peekRowId) ?? null,
    [enrichedRows, peekRowId]
  );
  const peekStage =
    peekRow?.statusId != null
      ? (statusById.get(peekRow.statusId) ?? null)
      : null;

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
      "Stage",
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
          (r.statusId && statusById.get(r.statusId)?.name) || "",
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
          <CustomersDisplayMenu
            density={density}
            onDensity={setDensity}
            hiddenColumns={hiddenColumns}
            onToggleColumn={toggleColumn}
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
                className={`w-full border-collapse text-left ${densityCls.table}`}
              >
                <thead>
                  <tr className="border-b border-kumo-line bg-kumo-tint/30 text-[11px] font-medium uppercase tracking-wider text-kumo-subtle select-none">
                    <th
                      className={`w-10 border-r border-kumo-line px-2 ${densityCls.cellY} text-right font-mono`}
                    >
                      #
                    </th>
                    <th
                      onClick={() => toggleSort("name")}
                      className={`min-w-[220px] cursor-pointer border-r border-kumo-line px-2.5 ${densityCls.cellY} hover:text-kumo-default`}
                    >
                      Company{" "}
                      {sortField === "name"
                        ? sortDir === "asc"
                          ? "↑"
                          : "↓"
                        : ""}
                    </th>
                    {columnVisible("category") && (
                      <th
                        onClick={() => toggleSort("category")}
                        className={`min-w-[180px] cursor-pointer border-r border-kumo-line px-2.5 ${densityCls.cellY} hover:text-kumo-default`}
                      >
                        Category{" "}
                        {sortField === "category"
                          ? sortDir === "asc"
                            ? "↑"
                            : "↓"
                          : ""}
                      </th>
                    )}
                    {columnVisible("stage") && (
                      <th
                        className={`min-w-[140px] border-r border-kumo-line px-2.5 ${densityCls.cellY}`}
                      >
                        Stage
                      </th>
                    )}
                    {columnVisible("owner") && (
                      <th
                        onClick={() => toggleSort("owner")}
                        className={`min-w-[100px] cursor-pointer border-r border-kumo-line px-2.5 ${densityCls.cellY} hover:text-kumo-default`}
                      >
                        Owner{" "}
                        {sortField === "owner"
                          ? sortDir === "asc"
                            ? "↑"
                            : "↓"
                          : ""}
                      </th>
                    )}
                    {columnVisible("phone") && (
                      <th
                        className={`min-w-[125px] border-r border-kumo-line px-2.5 ${densityCls.cellY}`}
                      >
                        Phone
                      </th>
                    )}
                    {columnVisible("location") && (
                      <th
                        onClick={() => toggleSort("location")}
                        className={`min-w-[220px] cursor-pointer border-r border-kumo-line px-2.5 ${densityCls.cellY} hover:text-kumo-default`}
                      >
                        Location{" "}
                        {sortField === "location"
                          ? sortDir === "asc"
                            ? "↑"
                            : "↓"
                          : ""}
                      </th>
                    )}
                    {columnVisible("signal") && (
                      <th
                        className={`min-w-[260px] border-r border-kumo-line px-2.5 ${densityCls.cellY}`}
                      >
                        Principal & Signal
                      </th>
                    )}
                    {columnVisible("score") && (
                      <th
                        onClick={() => toggleSort("score")}
                        className={`min-w-[90px] cursor-pointer border-r border-kumo-line px-2.5 ${densityCls.cellY} hover:text-kumo-default`}
                      >
                        Score{" "}
                        {sortField === "score"
                          ? sortDir === "asc"
                            ? "↑"
                            : "↓"
                          : ""}
                      </th>
                    )}
                    {columnVisible("added") && (
                      <th
                        onClick={() => toggleSort("added")}
                        className={`w-24 cursor-pointer px-2.5 ${densityCls.cellY} hover:text-kumo-default`}
                      >
                        Added{" "}
                        {sortField === "added"
                          ? sortDir === "asc"
                            ? "↑"
                            : "↓"
                          : ""}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {renderedRows.map((row, idx) => {
                    const customer = row.raw;
                    const isPeeked = peekRowId === customer.id;
                    const stage = row.statusId
                      ? (statusById.get(row.statusId) ?? null)
                      : null;
                    return (
                      <tr
                        key={customer.id}
                        onClick={() => setPeekRowId(customer.id)}
                        style={stageRowTint(stage)}
                        className={`cursor-pointer border-b border-kumo-line transition-colors ${
                          isPeeked ? "bg-kumo-tint/40" : "hover:bg-kumo-tint/20"
                        }`}
                      >
                        <td
                          className={`border-r border-kumo-line px-2 ${densityCls.cellY} text-right font-mono text-[11px] text-kumo-subtle`}
                        >
                          {idx + 1}
                        </td>
                        <td
                          className={`border-r border-kumo-line px-2.5 ${densityCls.cellY} whitespace-nowrap`}
                        >
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
                                {isFollowUpOverdue(row.nextStepDueAt) && (
                                  <span
                                    title={`${row.nextStepText ?? "Next step"} — due ${formatRelative(row.nextStepDueAt!)}`}
                                    className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-500"
                                  >
                                    <span
                                      aria-hidden
                                      className="size-1.5 rounded-full bg-red-500"
                                    />
                                    Due
                                  </span>
                                )}
                              </Link>
                            </EntityHover>
                            <span className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLogTouchTarget({
                                    id: customer.id,
                                    name: customer.name,
                                  });
                                }}
                                className="rounded border border-kumo-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-kumo-subtle hover:text-kumo-default"
                              >
                                Log
                              </button>
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
                            </span>
                          </div>
                        </td>
                        {columnVisible("category") && (
                          <td
                            className={`border-r border-kumo-line px-2.5 ${densityCls.cellY} whitespace-nowrap`}
                          >
                            <Badge variant="secondary">
                              {row.classified.categoryLabel}
                            </Badge>
                          </td>
                        )}
                        {columnVisible("stage") && (
                          <td
                            onClick={(e) => e.stopPropagation()}
                            className={`border-r border-kumo-line px-2 ${density === "compact" ? "py-0.5" : "py-1"} whitespace-nowrap`}
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                aria-hidden
                                className="inline-block size-2 rounded-full border border-kumo-line"
                                style={{
                                  backgroundColor:
                                    stageColor(stage) ?? "transparent",
                                }}
                              />
                              <select
                                aria-label={`Stage for ${customer.name}`}
                                value={row.statusId ?? ""}
                                onChange={(e) =>
                                  patchStage.mutate({
                                    customerId: customer.id,
                                    statusId: e.target.value || null,
                                  })
                                }
                                className="h-6 rounded border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
                              >
                                <option value="">No stage</option>
                                {stageOptions.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                                {row.statusId &&
                                  !statusById.has(row.statusId) && (
                                    <option value={row.statusId}>
                                      Unknown stage
                                    </option>
                                  )}
                              </select>
                            </span>
                          </td>
                        )}
                        {columnVisible("owner") && (
                          <td
                            onClick={(e) => e.stopPropagation()}
                            className={`border-r border-kumo-line px-2 ${density === "compact" ? "py-0.5" : "py-1"} whitespace-nowrap`}
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
                        )}
                        {columnVisible("phone") && (
                          <td
                            onClick={(e) => e.stopPropagation()}
                            className={`border-r border-kumo-line px-2.5 ${densityCls.cellY} whitespace-nowrap font-mono`}
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
                        )}
                        {columnVisible("location") && (
                          <td
                            className={`border-r border-kumo-line px-2.5 ${densityCls.cellY} whitespace-nowrap`}
                          >
                            <span className="truncate block max-w-[230px] text-kumo-subtle">
                              {row.neighborhood ? `${row.neighborhood} · ` : ""}
                              {row.address ?? "—"}
                            </span>
                          </td>
                        )}
                        {columnVisible("signal") && (
                          <td
                            className={`border-r border-kumo-line px-2.5 ${densityCls.cellY}`}
                          >
                            <span className="truncate block max-w-[290px] text-kumo-subtle">
                              {row.signal ?? row.classified.vortexWedge}
                            </span>
                          </td>
                        )}
                        {columnVisible("score") && (
                          <td
                            className={`border-r border-kumo-line px-2.5 ${densityCls.cellY} whitespace-nowrap font-mono`}
                          >
                            {row.fitScore != null ||
                            row.priorityScore != null ? (
                              <span>
                                F{row.fitScore ?? "—"} · P
                                {row.priorityScore ?? "—"}
                              </span>
                            ) : (
                              <span className="text-kumo-subtle">—</span>
                            )}
                          </td>
                        )}
                        {columnVisible("added") && (
                          <td
                            className={`px-2.5 ${densityCls.cellY} whitespace-nowrap text-kumo-subtle`}
                          >
                            {formatRelative(customer.createdAt)}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
                <span>
                  Showing {Math.min(visibleLimit, visibleRows.length)} of{" "}
                  {visibleRows.length} companies
                </span>
                {visibleRows.length > visibleLimit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setVisibleLimit((n) => n + PAGE_SIZE)}
                  >
                    Show more ({visibleRows.length - visibleLimit} remaining)
                  </Button>
                )}
              </div>
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
                  {peekStage && (
                    <Badge variant="secondary">
                      <span
                        aria-hidden
                        className="mr-1 inline-block size-1.5 rounded-full"
                        style={{ backgroundColor: stageColor(peekStage) }}
                      />
                      {peekStage.name}
                    </Badge>
                  )}
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

      <LogTouchDialog
        customerId={logTouchTarget?.id ?? null}
        customerName={logTouchTarget?.name ?? ""}
        open={logTouchTarget !== null}
        onOpenChange={(o) => {
          if (!o) setLogTouchTarget(null);
        }}
      />
    </div>
  );
}
