import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Eraser, SlidersHorizontal } from "@phosphor-icons/react";
import type { CSSProperties } from "react";

import type { SurfaceDensity } from "@/hooks/use-display-prefs";

/** Toggleable columns on the companies sheet. The row number and the
 * Company column stay pinned — a table with no name column is useless. */
export const CUSTOMER_COLUMN_DEFS = [
  { key: "category", label: "Category" },
  { key: "owner", label: "Owner" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "signal", label: "Principal & Signal" },
  { key: "score", label: "Score" },
  { key: "added", label: "Added" },
] as const;

export type CustomerColumnKey = (typeof CUSTOMER_COLUMN_DEFS)[number]["key"];

/** Sheets-style tab palette — fixed hex values so a chosen color can be
 * alpha-blended into the row tint deterministically. */
export const SHEET_COLOR_SWATCHES = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A color is only applied when it is a 6-digit hex (i.e. picked from the
 * swatch palette) — anything else falls back to the default look. */
export function normalizeSheetColor(
  color: string | null | undefined
): string | undefined {
  return color && HEX_COLOR.test(color) ? color : undefined;
}

/** Sheets-style row accent: a 3px colored left edge plus a faint tint
 * across the row so a sheet scans by color. Painted as background-image
 * layers so the Tailwind hover/selected background-color still shows
 * through underneath. Returns undefined when uncolored. */
export function sheetRowStyle(
  color: string | null | undefined
): CSSProperties | undefined {
  const hex = normalizeSheetColor(color);
  if (!hex) return undefined;
  return {
    backgroundImage: `linear-gradient(90deg, ${hex} 0px, ${hex} 3px, transparent 3px), linear-gradient(${hex}14, ${hex}14)`,
  };
}

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

export interface DisplaySheet {
  key: string;
  label: string;
}

/** Linear-style Display menu for the CRM sheet — density, column
 * visibility, and per-tab colors persisted via me/view-preferences. */
export function CustomersDisplayMenu({
  sheets,
  sheetColors,
  onSheetColor,
  density,
  onDensity,
  hiddenColumns,
  onToggleColumn,
  onClearSheetColors,
}: {
  sheets: readonly DisplaySheet[];
  sheetColors: Record<string, string> | undefined;
  onSheetColor: (sheetKey: string, color: string | null) => void;
  density: SurfaceDensity;
  onDensity: (density: SurfaceDensity) => void;
  hiddenColumns: readonly string[] | undefined;
  onToggleColumn: (column: CustomerColumnKey) => void;
  onClearSheetColors: () => void;
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
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>Sheet tab colors</DropdownMenu.Label>
          <div className="flex flex-col gap-1.5 px-3 py-1.5">
            {sheets.map((sheet) => {
              const current = normalizeSheetColor(sheetColors?.[sheet.key]);
              return (
                <div
                  key={sheet.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate text-xs text-kumo-default">
                    {sheet.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {SHEET_COLOR_SWATCHES.map((swatch) => (
                      <button
                        key={swatch.name}
                        type="button"
                        title={swatch.name}
                        aria-label={`${sheet.label}: ${swatch.name}`}
                        aria-pressed={current === swatch.value}
                        onClick={() =>
                          onSheetColor(
                            sheet.key,
                            current === swatch.value ? null : swatch.value
                          )
                        }
                        className={`size-3.5 rounded-full transition-transform hover:scale-125 ${
                          current === swatch.value
                            ? "ring-2 ring-kumo-brand"
                            : ""
                        }`}
                        style={{ backgroundColor: swatch.value }}
                      />
                    ))}
                    <button
                      type="button"
                      title="Clear color"
                      aria-label={`${sheet.label}: clear color`}
                      onClick={() => onSheetColor(sheet.key, null)}
                      className="flex size-3.5 items-center justify-center rounded-full border border-kumo-line text-[8px] leading-none text-kumo-subtle hover:text-kumo-default"
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </DropdownMenu.Group>
        {Object.keys(sheetColors ?? {}).length > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item icon={<Eraser />} onClick={onClearSheetColors}>
              Clear all sheet colors
            </DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
