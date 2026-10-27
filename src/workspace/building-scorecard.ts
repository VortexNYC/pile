// PILE-662 — Landlord / building scorecard for NYC field canvassing.
//
// Ronnie's `XRF!!` leads are buildings and landlords, not storefront
// merchants with POS terminals — they must not be forced through
// `rankMerchantSignals`' SMB ICP. This module scores a building lead from
// PLUTO / ACRIS / HPD attributes: unit count, the Local Law 31 XRF
// lead-paint testing window, building scale, and ownership/violation
// urgency signals, plus a Socrata lookup that fills those attributes from
// NYC Open Data.

/** Attributes a scorecard call site knows about a building — everything
 *  is optional because PLUTO coverage is uneven and reps hand-enter
 *  partial data at the door. */
export interface BuildingAttributes {
  /** 10-digit Borough-Block-Lot tax id. */
  bbl?: string | null;
  /** DOB Building Identification Number. */
  bin?: string | null;
  address?: string | null;
  borough?: string | null;
  zipcode?: string | null;
  /** Residential units (PLUTO `unitsres`). */
  unitsRes?: number | null;
  /** Total units incl. commercial (PLUTO `unitstotal`). */
  unitsTotal?: number | null;
  /** Gross building area (PLUTO `bldgarea`). */
  buildingSqft?: number | null;
  /** Total assessed value in dollars (PLUTO `assesstot`). */
  assessedTotalDollars?: number | null;
  yearBuilt?: number | null;
  /** Last ACRIS-recorded sale price in dollars. */
  lastSalePriceDollars?: number | null;
  /** ISO date of the last ACRIS-recorded sale. */
  lastSaleDate?: string | null;
  hpdRegistrationId?: string | null;
  hpdManagingAgent?: string | null;
  hpdOwnerName?: string | null;
  openViolationsCount?: number | null;
}

export interface BuildingScorecardFactor {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export type BuildingTier = "A" | "B" | "C" | "D";

export type BuildingPortfolioScale =
  | "large_multifamily"
  | "mid_multifamily"
  | "small_multifamily"
  | "single_or_commercial";

export interface BuildingScorecardBreakdown {
  /** 0..100 — sum of factor points, capped. */
  score: number;
  tier: BuildingTier;
  /** NYC Local Law 31 XRF lead-paint testing applies: a multiple dwelling
   *  (>= 3 residential units) built before 1978. */
  xrfLeadPaintEligible: boolean;
  portfolioScale: BuildingPortfolioScale;
  whyNow: string;
  factors: BuildingScorecardFactor[];
}

const DAY_MS = 86_400_000;
/** An ACRIS sale counts as a "just changed hands" signal for 3 years. */
const RECENT_SALE_WINDOW_MS = 3 * 365 * DAY_MS;

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatDollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function scoreToTier(score: number): BuildingTier {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

function toPortfolioScale(units: number): BuildingPortfolioScale {
  if (units >= 50) return "large_multifamily";
  if (units >= 20) return "mid_multifamily";
  if (units >= 3) return "small_multifamily";
  return "single_or_commercial";
}

/** Score a building/landlord lead 0–100. The XRF lead-paint mandate is the
 *  wedge: pre-war multiple dwellings are legally required to XRF-test
 *  every unit, so scale × LL31 window dominates the rubric. */
export function scoreBuildingLead(
  attrs: BuildingAttributes,
  options?: { nowMs?: number }
): BuildingScorecardBreakdown {
  const nowMs = options?.nowMs ?? Date.now();
  const factors: BuildingScorecardFactor[] = [];

  const unitsTotal = positiveNumber(attrs.unitsTotal);
  const dwellingUnits = positiveNumber(attrs.unitsRes) ?? unitsTotal ?? 0;
  const yearBuilt = positiveNumber(attrs.yearBuilt);
  const buildingSqft = positiveNumber(attrs.buildingSqft);
  const assessedTotalDollars = positiveNumber(attrs.assessedTotalDollars);

  // Unit count — portfolio scale is the size of the XRF job.
  if (unitsTotal !== null) {
    let points = 0;
    let scaleLabel = "1–2 units";
    if (unitsTotal >= 50) {
      points = 35;
      scaleLabel = "50+ units";
    } else if (unitsTotal >= 20) {
      points = 28;
      scaleLabel = "20–49 units";
    } else if (unitsTotal >= 6) {
      points = 20;
      scaleLabel = "6–19 units";
    } else if (unitsTotal >= 3) {
      points = 12;
      scaleLabel = "3–5 units";
    } else {
      points = 4;
    }
    factors.push({
      key: "units",
      label: "Unit count",
      points,
      detail: `${unitsTotal}-unit property (${scaleLabel})`,
    });
  }

  // XRF / pre-1960 / pre-1978 — Local Law 31 requires XRF lead-paint
  // testing in multiple dwellings (3+ units) built before 1960; 1960–1978
  // buildings still sit in the lead-paint era.
  const xrfLeadPaintEligible =
    dwellingUnits >= 3 && yearBuilt !== null && yearBuilt < 1978;
  if (yearBuilt !== null && yearBuilt < 1960 && dwellingUnits >= 3) {
    factors.push({
      key: "ll31_xrf_pre1960",
      label: "LL31 XRF window",
      points: 25,
      detail: `Built ${yearBuilt} — Local Law 31 XRF lead-paint testing mandatory for pre-1960 multiple dwellings`,
    });
  } else if (yearBuilt !== null && yearBuilt >= 1960 && yearBuilt < 1978) {
    factors.push({
      key: "pre1978_lead_paint_era",
      label: "Pre-1978 building",
      points: 15,
      detail: `Built ${yearBuilt} — 1960–1978 lead-paint-era building`,
    });
  }

  // Building area / assessed value — proxy for job size when unit data is
  // thin.
  const scaleSignals: string[] = [];
  if (buildingSqft !== null) {
    scaleSignals.push(`${buildingSqft.toLocaleString("en-US")} sqft`);
  }
  if (assessedTotalDollars !== null) {
    scaleSignals.push(`assessed at ${formatDollars(assessedTotalDollars)}`);
  }
  if (
    (buildingSqft !== null && buildingSqft >= 25_000) ||
    (assessedTotalDollars !== null && assessedTotalDollars >= 2_000_000)
  ) {
    factors.push({
      key: "building_scale",
      label: "Large building / high assessed value",
      points: 15,
      detail: scaleSignals.join(", ") || "Large building footprint",
    });
  } else if (
    (buildingSqft !== null && buildingSqft >= 5_000) ||
    (assessedTotalDollars !== null && assessedTotalDollars >= 500_000)
  ) {
    factors.push({
      key: "building_scale",
      label: "Mid-size building / assessed value",
      points: 8,
      detail: scaleSignals.join(", ") || "Mid-size building footprint",
    });
  }

  // HPD registration / active ownership — a registered landlord is a
  // reachable, legally exposed buyer.
  if (nonEmpty(attrs.hpdRegistrationId) || nonEmpty(attrs.hpdOwnerName)) {
    const who = nonEmpty(attrs.hpdOwnerName);
    factors.push({
      key: "hpd_registered",
      label: "HPD registration on file",
      points: 10,
      detail: who
        ? `HPD-registered ownership (${who})`
        : `HPD registration ${nonEmpty(attrs.hpdRegistrationId)}`,
    });
  }

  // Open HPD violations — active enforcement pressure is the strongest
  // "call this week" urgency signal a canvasser can carry.
  const openViolations =
    typeof attrs.openViolationsCount === "number" &&
    Number.isFinite(attrs.openViolationsCount)
      ? attrs.openViolationsCount
      : 0;
  if (openViolations > 0) {
    factors.push({
      key: "open_violations",
      label: "Open HPD violations",
      points: 15,
      detail: `${openViolations} open violation${openViolations === 1 ? "" : "s"} — active enforcement pressure`,
    });
  }

  // Recent ACRIS sale — new owners re-evaluate vendors in year one.
  const saleMs = attrs.lastSaleDate ? Date.parse(attrs.lastSaleDate) : NaN;
  if (
    Number.isFinite(saleMs) &&
    saleMs <= nowMs &&
    nowMs - saleMs <= RECENT_SALE_WINDOW_MS
  ) {
    const price = positiveNumber(attrs.lastSalePriceDollars);
    factors.push({
      key: "recent_sale",
      label: "Recent ACRIS sale",
      points: 10,
      detail: `Sold ${attrs.lastSaleDate!.slice(0, 10)}${price ? ` for ${formatDollars(price)}` : ""} — new ownership`,
    });
  }

  const score = Math.min(
    100,
    factors.reduce((sum, factor) => sum + factor.points, 0)
  );
  const portfolioUnits = unitsTotal ?? positiveNumber(attrs.unitsRes) ?? 0;
  const portfolioScale = toPortfolioScale(portfolioUnits);

  const highlights = factors
    .toSorted((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((factor) => factor.detail);
  const whyNow =
    highlights.length === 0
      ? "Building lead — no PLUTO/HPD attributes on record yet"
      : `${xrfLeadPaintEligible ? "LL31 XRF lead-paint mandate applies — " : ""}${highlights.join("; ")}`;

  return {
    score,
    tier: scoreToTier(score),
    xrfLeadPaintEligible,
    portfolioScale,
    whyNow,
    factors,
  };
}

// ---- NYC Open Data (Socrata) lookup ----

const SOCRATA_NYC_DOMAIN = "data.cityofnewyork.us";
const PLUTO_DATASET = "64uk-42ks";
const HPD_REGISTRATIONS_DATASET = "tesw-yqqr";

const BOROUGH_CODES: Record<string, string> = {
  manhattan: "MN",
  "new york": "MN",
  bronx: "BX",
  "the bronx": "BX",
  brooklyn: "BK",
  queens: "QN",
  "staten island": "SI",
  mn: "MN",
  bx: "BX",
  bk: "BK",
  qn: "QN",
  si: "SI",
};

const BOROUGH_NAMES: Record<string, string> = {
  MN: "Manhattan",
  BX: "Bronx",
  BK: "Brooklyn",
  QN: "Queens",
  SI: "Staten Island",
};

/** PLUTO `address` values use full street suffixes ("STREET", "AVENUE") —
 *  expand the abbreviations a rep would type so the LIKE query matches. */
const STREET_SUFFIX_EXPANSIONS: Record<string, string> = {
  ST: "STREET",
  AVE: "AVENUE",
  RD: "ROAD",
  BLVD: "BOULEVARD",
  PL: "PLACE",
  DR: "DRIVE",
  CT: "COURT",
  LN: "LANE",
  TER: "TERRACE",
  PKWY: "PARKWAY",
  HWY: "HIGHWAY",
};

function escapeSoql(value: string): string {
  return value.replace(/'/g, "''");
}

/** Split a free-form street address ("123-45 Main St, Brooklyn, NY
 *  11206") into a house-number token and a suffix-expanded street name
 *  for SoQL LIKE matching. */
function splitStreetLine(address: string): {
  houseNumber: string | null;
  streetName: string;
  zipcode: string | null;
} {
  const first = (address.split(",")[0] ?? "").trim();
  const zipMatch = /\b(\d{5})(?:-\d{4})?\b/.exec(address);
  const houseMatch = /^(\d[\d-]*[A-Za-z]?)\s+(.+)$/.exec(first);
  const rawStreet = (houseMatch ? houseMatch[2]! : first)
    .toUpperCase()
    .replace(/[.#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const expanded = rawStreet
    .split(" ")
    .map((token) => STREET_SUFFIX_EXPANSIONS[token] ?? token)
    .join(" ");
  return {
    houseNumber: houseMatch ? houseMatch[1]!.toUpperCase() : null,
    streetName: expanded,
    zipcode: zipMatch ? zipMatch[1]! : null,
  };
}

function boroughCodeFor(value: string | null | undefined): string | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (BOROUGH_CODES[lower]) return BOROUGH_CODES[lower]!;
  // "Bushwick, Brooklyn" style neighborhood blobs — look for a borough
  // name inside the string.
  for (const [name, code] of Object.entries(BOROUGH_CODES)) {
    if (name.length > 2 && lower.includes(name)) return code;
  }
  return null;
}

function socrataString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function socrataNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function socrataQuery(
  dataset: string,
  params: URLSearchParams,
  options?: { appToken?: string; fetchFn?: typeof fetch }
): Promise<Array<Record<string, unknown>>> {
  const fetchFn = options?.fetchFn ?? fetch;
  const res = await fetchFn(
    `https://${SOCRATA_NYC_DOMAIN}/resource/${dataset}.json?${params}`,
    options?.appToken
      ? { headers: { "X-App-Token": options.appToken } }
      : undefined
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/** Pull PLUTO + HPD registration attributes for a street address from NYC
 *  Open Data. Never throws — a network failure or empty result just
 *  returns whatever attributes were resolved (possibly none). */
export async function lookupNycBuildingSocrata(
  address: string,
  borough?: string | null,
  options?: { appToken?: string; fetchFn?: typeof fetch }
): Promise<BuildingAttributes> {
  const attrs: BuildingAttributes = { address: address || null };
  try {
    const { houseNumber, streetName, zipcode } = splitStreetLine(address);
    const boroCode = boroughCodeFor(borough) ?? boroughCodeFor(address);
    if (zipcode) attrs.zipcode = zipcode;
    if (borough) attrs.borough = borough;

    const buildWhere = (includeHouse: boolean) => {
      const where: string[] = [];
      if (streetName) {
        where.push(`upper(address) like '%${escapeSoql(streetName)}%'`);
      }
      if (includeHouse && houseNumber) {
        where.push(`upper(address) like '${escapeSoql(houseNumber)} %'`);
      }
      if (boroCode) where.push(`borough = '${boroCode}'`);
      if (zipcode) where.push(`zipcode = '${zipcode}'`);
      return where.join(" AND ");
    };

    let rows = await socrataQuery(
      PLUTO_DATASET,
      new URLSearchParams({ $limit: "5", $where: buildWhere(true) }),
      options
    );
    // House-number prefix match is strict ("123 %") — retry street-only
    // when it narrows to nothing (ranges like "123-125" miss the space).
    if (rows.length === 0 && houseNumber) {
      rows = await socrataQuery(
        PLUTO_DATASET,
        new URLSearchParams({ $limit: "5", $where: buildWhere(false) }),
        options
      );
    }

    const pluto = rows[0];
    if (pluto) {
      attrs.bbl = socrataString(pluto.bbl);
      attrs.bin = socrataString(pluto.bin);
      attrs.address = socrataString(pluto.address) ?? attrs.address;
      const plutoBorough = socrataString(pluto.borough);
      attrs.borough = plutoBorough
        ? (BOROUGH_NAMES[plutoBorough.toUpperCase()] ?? plutoBorough)
        : (borough ?? null);
      attrs.zipcode = socrataString(pluto.zipcode) ?? attrs.zipcode;
      attrs.unitsRes = socrataNumber(pluto.unitsres);
      attrs.unitsTotal = socrataNumber(pluto.unitstotal);
      attrs.buildingSqft = socrataNumber(pluto.bldgarea);
      attrs.assessedTotalDollars = socrataNumber(pluto.assesstot);
      attrs.yearBuilt = socrataNumber(pluto.yearbuilt);
    }

    // Optional HPD registrations — a registration id proves the landlord
    // is in HPD's system (registered = reachable + legally exposed).
    const bblDigits = (attrs.bbl ?? "").replace(/\D+/g, "");
    const hpdWhere: string[] = [];
    if (bblDigits.length === 10) {
      hpdWhere.push(`boroid = '${bblDigits[0]}'`);
      hpdWhere.push(`block = '${Number(bblDigits.slice(1, 6))}'`);
      hpdWhere.push(`lot = '${Number(bblDigits.slice(6))}'`);
    } else if (streetName && houseNumber) {
      hpdWhere.push(`housenumber = '${escapeSoql(houseNumber)}'`);
      hpdWhere.push(`upper(streetname) like '%${escapeSoql(streetName)}%'`);
    }
    if (hpdWhere.length > 0) {
      const hpdRows = await socrataQuery(
        HPD_REGISTRATIONS_DATASET,
        new URLSearchParams({
          $limit: "3",
          $where: hpdWhere.join(" AND "),
        }),
        options
      );
      const hpd = hpdRows[0];
      if (hpd) {
        attrs.hpdRegistrationId =
          socrataString(hpd.registrationid) ?? socrataString(hpd.buildingid);
        attrs.bin = attrs.bin ?? socrataString(hpd.bin);
        attrs.hpdManagingAgent =
          socrataString(hpd.managingagent) ?? socrataString(hpd.agent);
        attrs.hpdOwnerName =
          socrataString(hpd.ownername) ?? socrataString(hpd.corporationname);
      }
    }
  } catch {
    // Network/parse failures degrade to "no lookup data" — the scorecard
    // runs on whatever attributes the caller already had.
  }
  return attrs;
}
