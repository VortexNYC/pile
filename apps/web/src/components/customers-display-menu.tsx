import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { SlidersHorizontal } from "@phosphor-icons/react";

import type { SurfaceDensity } from "@/hooks/use-display-prefs";

/** Toggleable columns on the companies sheet. The row number and the
 * Company column stay pinned — a table with no name column is useless. */
export const CUSTOMER_COLUMN_DEFS = [
  { key: "category", label: "Category" },
  { key: "stage", label: "Stage" },
  { key: "owner", label: "Owner" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "signal", label: "Principal & Signal" },
  { key: "score", label: "Score" },
  { key: "added", label: "Added" },
] as const;

export type CustomerColumnKey = (typeof CUSTOMER_COLUMN_DEFS)[number]["key"];

/** Density drives the table text size and the vertical cell padding. */
export function densityClasses(density: SurfaceDensity | undefined): {
  table: string;
  cellY: string;
} {
  return density === "compact"
    ? { table: "text-[11px]", cellY: "py-1" }
    : { table: "text-xs", cellY: "py-1.5" };
}

export function isColumnVisible(
  hiddenColumns: readonly string[] | undefined,
  key: CustomerColumnKey
): boolean {
  return !(hiddenColumns ?? []).includes(key);
}

/** Linear-style Display menu for the CRM sheet — density and column
 * visibility persisted via me/view-preferences. Row color is the
 * customer's pipeline stage, not a cosmetic pref, so it lives on the
 * status itself rather than in this menu. */
export function CustomersDisplayMenu({
  density,
  onDensity,
  hiddenColumns,
  onToggleColumn,
}: {
  density: SurfaceDensity;
  onDensity: (density: SurfaceDensity) => void;
  hiddenColumns: readonly string[] | undefined;
  onToggleColumn: (column: CustomerColumnKey) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" size="sm" icon={<SlidersHorizontal />}>
            Display
          </Button>
        }
      />
      <DropdownMenu.Content className="min-w-64">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Row density</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={density}
            onValueChange={(v) => onDensity(v as SurfaceDensity)}
          >
            <DropdownMenu.RadioItem value="comfortable">
              Comfortable
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="compact">
              Compact
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>Columns</DropdownMenu.Label>
          {CUSTOMER_COLUMN_DEFS.map((col) => (
            <DropdownMenu.CheckboxItem
              key={col.key}
              checked={isColumnVisible(hiddenColumns, col.key)}
              onCheckedChange={() => onToggleColumn(col.key)}
            >
              {col.label}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
