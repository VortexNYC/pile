import type { CSSProperties } from "react";

/** Minimal shape of a workspace customer-status row (GET
 * /workspaces/{org}/customer-statuses). `key` is the immutable binding
 * slug minted at create; `color` is an optional operator override. */
export interface CustomerStage {
  id: string;
  name: string;
  key: string | null;
  type: string;
  color: string | null;
  position: number;
}

/** Canonical pipeline stages for a Vortex sales workspace — the ordered
 * sheet columns Ronnie works left→right, each bound to one fixed semantic
 * color so a row scans by pipeline position. Colors run cool→warm through
 * the funnel: sky for untouched prospects up to emerald for passed and
 * rose for lost. */
export const CUSTOMER_STAGES = [
  { key: "prospect", label: "Prospect", color: "#38bdf8" },
  { key: "outreach", label: "Outreach", color: "#6366f1" },
  { key: "discovery", label: "Discovery", color: "#8b5cf6" },
  { key: "proposal", label: "Proposal", color: "#f59e0b" },
  {
    key: "application_underwriting",
    label: "Application underwriting",
    color: "#fb923c",
  },
  { key: "contracting", label: "Contracting", color: "#f97316" },
  { key: "onboarding_go_live", label: "Onboarding go-live", color: "#14b8a6" },
  { key: "passed", label: "Passed", color: "#10b981" },
  { key: "lost", label: "Lost", color: "#f43f5e" },
] as const;

/** Semantic colors by status key. Canonical stage keys come first; the
 * extra entries keep the same color story for the generic sheet
 * vocabulary (new/contacted/engaged/quoted/…) that corridor imports and
 * other workspaces use. */
const STAGE_KEY_COLORS: Record<string, string> = Object.fromEntries([
  ...CUSTOMER_STAGES.map((s) => [s.key, s.color] as const),
  ["new", "#38bdf8"],
  ["contacted", "#6366f1"],
  ["engaged", "#8b5cf6"],
  ["quoted", "#f59e0b"],
  ["underwriting", "#fb923c"],
  ["negotiating", "#f97316"],
  ["negotiation", "#f97316"],
  ["won", "#10b981"],
  ["dead", "#f43f5e"],
  ["nurture", "#a1a1aa"],
]);

/** Deterministic palette for statuses outside the canonical vocabulary —
 * a custom stage still gets a stable row color instead of none. */
const FALLBACK_STAGE_COLORS = [
  "#0ea5e9",
  "#d946ef",
  "#84cc16",
  "#eab308",
  "#f97316",
  "#64748b",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A color is only applied when it is a 6-digit hex — anything else falls
 * back to the canonical stage color. */
export function normalizeHexColor(
  color: string | null | undefined
): string | undefined {
  return color && HEX_COLOR.test(color) ? color : undefined;
}

/** Immutable identity of a stage: its `key` when present, else the same
 * slug the backend mints from the name (stageKey in
 * src/workspace/data). */
export function stageKeyOf(
  stage: Pick<CustomerStage, "name" | "key"> | null | undefined
): string {
  if (!stage) return "";
  return (
    stage.key ??
    stage.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  );
}

function fallbackStageColor(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_STAGE_COLORS[hash % FALLBACK_STAGE_COLORS.length]!;
}

/** The semantic color for a stage: the status's own `color` override when
 * set, else the canonical color for its key, else a deterministic
 * fallback so custom stages still tint. Undefined for "no stage". */
export function stageColor(
  stage: Pick<CustomerStage, "name" | "key" | "color"> | null | undefined
): string | undefined {
  if (!stage) return undefined;
  return (
    normalizeHexColor(stage.color) ??
    STAGE_KEY_COLORS[stageKeyOf(stage)] ??
    fallbackStageColor(stageKeyOf(stage))
  );
}

/** Sheets-style row accent for the stage column color: a 3px colored left
 * edge plus a faint tint across the row. Painted as background-image
 * layers so the Tailwind hover/selected background-color still shows
 * through underneath. Returns undefined when the row has no stage. */
export function stageRowTint(
  stage: Pick<CustomerStage, "name" | "key" | "color"> | null | undefined
): CSSProperties | undefined {
  const hex = stageColor(stage);
  if (!hex) return undefined;
  return {
    backgroundImage: `linear-gradient(90deg, ${hex} 0px, ${hex} 3px, transparent 3px), linear-gradient(${hex}14, ${hex}14)`,
  };
}

/** Statuses ordered by pipeline position — the select's option order. */
export function orderedStages<T extends { position: number }>(
  stages: readonly T[]
): T[] {
  return [...stages].toSorted((a, b) => a.position - b.position);
}
