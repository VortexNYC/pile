// Collector — pulls a merchant_source's feed, normalizes rows into
// MerchantCandidates, scores them. Deterministic: the agent decides WHEN to
// run a source and what to do with the queue; the pull itself is mechanical.

export interface MerchantSourceRow {
  id: string;
  name: string;
  kind: string;
  config: string;
  cursorField: string | null;
  cursorValue: string | null;
  signal: string;
}

export interface MerchantCandidate {
  name: string;
  externalId: string;
  domain?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  ownerName?: string | null;
  neighborhood?: string | null;
  vertical?: string | null;
  signal: string;
  signalDate?: string | null;
  evidenceUri?: string | null;
  /** PILE-660/661 — estimated monthly card volume in integer cents when the
   *  source carries real dollars (job cost, award amount, 990 revenue). */
  estMonthlyVolumeCents?: number | null;
  /** PILE-657/660/661 — source-specific fields carried through for the
   *  enricher/ranker (rating counts, award/payment/job dollar amounts). */
  raw?: Record<string, unknown> | null;
}

const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "verizon.net",
  "optimum.net",
  "optonline.net",
  "earthlink.net",
  "comcast.net",
  "att.net",
  "sbcglobal.net",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "mail.com",
]);

const FREEMAIL_PREFIXES = [
  "gmail.",
  "googlemail.",
  "yahoo.",
  "ymail.",
  "aol.",
  "hotmail.",
  "outlook.",
  "live.",
  "msn.",
  "icloud.",
  "protonmail.",
  "proton.",
];

export function deriveDomainFromEmail(
  email: string | null | undefined
): string | null {
  if (!email || !email.includes("@")) return null;
  const host = email.split("@")[1]?.trim().toLowerCase();
  if (!host || !host.includes(".") || FREEMAIL_DOMAINS.has(host)) return null;
  if (FREEMAIL_PREFIXES.some((p) => host.startsWith(p))) return null;
  return host;
}

export type NonPosSmbPresetId =
  | "nyc_dob_contractors_and_trades"
  | "nyc_bic_commercial_haulers"
  | "nyc_dob_permit_issuances"
  | "nyc_home_improvement_contractors"
  | "nyc_auto_and_garages"
  | "nyc_b2b_and_specialty_dealers"
  | "nyc_bookkeepers_and_cpas"
  | "nyc_vc_and_accelerators"
  | "nyc_tech_and_software_startups"
  | "us_nppes_medical_and_dental"
  | "us_sec_form_d_tech_startups"
  | "nyc_dob_permit_job_value"
  | "nys_tax_warrants"
  | "nys_ucc_filings"
  | "irs_990_nonprofits"
  | "nyc_checkbook";

export type LeadSheetKey =
  | "trades"
  | "tech"
  | "partners_accounting"
  | "partners_vc"
  | "exploration"
  | "storefront_smb"
  | "target_non_pos_smb"
  | "excluded_pos";

export interface MerchantLeadClassification {
  sheetKey: LeadSheetKey;
  categoryLabel: string;
  vortexWedge: string;
}

/** PILE-663 — storefront verticals that are card-present businesses. The
 *  POS-bound set needs a restaurant/retail POS (Toast/Clover locked);
 *  non-POS storefronts can take a terminal + invoicing motion. */
const STOREFRONT_NON_POS_KEYWORDS = [
  "retail",
  "grocery",
  "salon",
  "barber",
  "spa",
  "boutique",
  "convenience",
  "florist",
  "dry clean",
];

/** Franchise / chain names whose POS stack is corporate-locked — no amount
 *  of rate competition wins them, so they stay excluded even when
 *  storefronts are included. */
const HARD_POS_FRANCHISE_RE =
  /\b(mcdonald'?s|subway|dunkin'?|domino'?s|pizza hut|starbucks|chipotle|chick-fil-a|taco bell|wendy'?s|burger king|popeyes|shake shack|sweetgreen|7-eleven|dollar tree)\b/i;

export function classifyMerchantLead(
  input: {
    name?: string | null;
    vertical?: string | null;
    source?: string | null;
  },
  options?: {
    /** PILE-663 — when true (or `excludePosStorefronts === false`) storefront
     *  merchants land on the `storefront_smb` / `target_non_pos_smb` sheets
     *  instead of `excluded_pos`. */
    includeStorefronts?: boolean;
    excludePosStorefronts?: boolean;
  }
): MerchantLeadClassification {
  const v = (input.vertical ?? "").toLowerCase();
  const n = (input.name ?? "").toLowerCase();
  const s = (input.source ?? "").toLowerCase();
  const includeStorefronts =
    options?.includeStorefronts === true ||
    options?.excludePosStorefronts === false;

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
      vortexWedge: "Partner Residual Rev-Share (20-100+ SMB Client Book)",
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
      vortexWedge: "Portfolio Startup Perks + Partner Rev-Share",
    };
  }

  if (
    v.includes("tech") ||
    v.includes("software") ||
    v.includes("saas") ||
    s.includes("startup") ||
    /\b(technologies|software|ai labs)\b/.test(n)
  ) {
    return {
      sheetKey: "tech",
      categoryLabel: "Tech / AI / SaaS Startup",
      vortexWedge: "Polar/Stripe Parity: SDKs + Subscriptions + $10 ACH",
    };
  }

  // PILE-663 — hard locked-in POS franchises stay excluded even when the
  // caller opts storefronts in; their POS stack is corporate-controlled.
  if (HARD_POS_FRANCHISE_RE.test(n)) {
    return {
      sheetKey: "excluded_pos",
      categoryLabel: "Restaurant / POS Franchise (Excluded)",
      vortexWedge: "Excluded — Locked-In Corporate POS",
    };
  }

  const posBoundStorefront =
    v.includes("restaurant") ||
    v.includes("bar") ||
    v.includes("cafe") ||
    v.includes("bakery") ||
    v.includes("pizzeria") ||
    v.includes("deli") ||
    v.includes("nightclub") ||
    v.includes("excluded") ||
    /\b(pizzeria|osteria|bistro|taqueria|bakery|bagel|cafe|beer hall|delicatessen|grill)\b/.test(
      n
    );
  const nonPosStorefront = STOREFRONT_NON_POS_KEYWORDS.some((k) =>
    v.includes(k)
  );

  if (posBoundStorefront || nonPosStorefront) {
    // PILE-663 — storefronts with card-present / rate-competition fit are
    // targets, not exclusions, when the caller opts them in.
    if (includeStorefronts) {
      return nonPosStorefront
        ? {
            sheetKey: "target_non_pos_smb",
            categoryLabel: "Storefront SMB — Non-POS Target",
            vortexWedge: "Terminal + Payment Links + Invoicing + ACH",
          }
        : {
            sheetKey: "storefront_smb",
            categoryLabel: "Storefront SMB — Card-Present Rate Competition",
            vortexWedge:
              "Countertop Terminal + Surcharging + Rate-vs-POS-Lock Competition",
          };
    }
    if (posBoundStorefront) {
      return {
        sheetKey: "excluded_pos",
        categoryLabel: "Restaurant / POS (Excluded)",
        vortexWedge: "Excluded — Requires Restaurant POS",
      };
    }
    // Non-POS storefronts without inclusion fall through to exploration.
  }

  if (v.includes("electrical")) {
    return {
      sheetKey: "trades",
      categoryLabel: "Electrical Contractor",
      vortexWedge: "Hosted Invoice + $10-Capped ACH + Surcharging",
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
      vortexWedge: "Hosted Invoice + $10-Capped ACH + Surcharging",
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
      vortexWedge: "Recurring B2B Invoices + Card-on-File + ACH",
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
      vortexWedge: "Hosted Invoice + $10-Capped ACH + Deposit Links",
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
      categoryLabel: "Auto, Garage & Towing (20% Explore)",
      vortexWedge: "Countertop Terminal + Surcharging + Text-to-Pay",
    };
  }
  if (
    v.includes("disabled") ||
    v.includes("medical") ||
    v.includes("dental") ||
    v.includes("dentist") ||
    v.includes("clinic") ||
    v.includes("physical therapist") ||
    v.includes("chiropract") ||
    v.includes("optometr") ||
    v.includes("health") ||
    v.includes("pharmacy") ||
    s.includes("nppes")
  ) {
    return {
      sheetKey: "exploration",
      categoryLabel: "Medical, Dental & DME (20% Explore)",
      vortexWedge: "Hosted Payment Links + Card-on-File + Terminal",
    };
  }

  return {
    sheetKey: "exploration",
    categoryLabel: input.vertical || "B2B & Specialty SMB (20% Explore)",
    vortexWedge: "Invoicing + Payment Links + ACH",
  };
}

export const PRESET_NON_POS_SMB_SOURCES: Record<
  NonPosSmbPresetId,
  MerchantSourceRow
> = {
  nyc_dob_contractors_and_trades: {
    id: "preset_nyc_dob_lic",
    name: "NYC DOB Active General Contractors, Plumbers, Electricians & Engineering Firms",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "t8hj-ruu2",
      name_field: "business_name",
      id_field: "license_sl_no",
      vertical_field: "license_type",
      phone_field: "business_phone_number",
      email_field: "business_email",
      borough_field: "license_business_city",
      where:
        "license_status='ACTIVE' AND business_phone_number IS NOT NULL AND business_email IS NOT NULL AND business_name IS NOT NULL AND license_type IN ('GENERAL CONTRACTOR', 'ELECTRICAL FIRM', 'MASTER PLUMBER', 'FILING REPRESENTATIVE', 'SPECIAL INSPECTION AGENCY', 'FIRE SUPPRESSION CONTRACTOR', 'RIGGER', 'OIL BURNER INSTALLER')",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "new_license",
  },
  nyc_bic_commercial_haulers: {
    id: "preset_nyc_bic",
    name: "NYC BIC Active Commercial Construction & Trade Waste Licensees",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "867j-5pgi",
      name_field: "account_name",
      id_field: "bic_number",
      vertical_field: "application_type",
      phone_field: "phone",
      email_field: "email",
      borough_field: "city",
      where:
        "phone IS NOT NULL AND email IS NOT NULL AND account_name IS NOT NULL",
    }),
    cursorField: "created",
    cursorValue: null,
    signal: "new_license",
  },
  nyc_dob_permit_issuances: {
    id: "preset_nyc_dob_permits",
    name: "NYC DOB Active Building & Trade Permit Issuances",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "ipu4-2q9a",
      name_field: "permittee_s_business_name",
      id_field: "permit_si_no",
      vertical_field: "permittee_s_license_type",
      phone_field: "permittee_s_phone__",
      borough_field: "borough",
      where:
        "permittee_s_business_name IS NOT NULL AND permittee_s_business_name != 'N/A' AND permittee_s_phone__ IS NOT NULL",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "new_license",
  },
  nyc_home_improvement_contractors: {
    id: "preset_nyc_hic",
    name: "NYC DCWP Active Home Improvement Contractors",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "w7w3-xahh",
      name_field: "business_name",
      id_field: "license_nbr",
      vertical_field: "business_category",
      phone_field: "contact_phone",
      borough_field: "address_borough",
      where:
        "license_status='Active' AND contact_phone IS NOT NULL AND address_street_name IS NOT NULL AND business_category='Home Improvement Contractor'",
    }),
    cursorField: "license_creation_date",
    cursorValue: null,
    signal: "new_license",
  },
  nyc_auto_and_garages: {
    id: "preset_nyc_auto",
    name: "NYC DCWP Active Auto Dealers, Garages, Tow & Car Wash",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "w7w3-xahh",
      name_field: "business_name",
      id_field: "license_nbr",
      vertical_field: "business_category",
      phone_field: "contact_phone",
      borough_field: "address_borough",
      where:
        "license_status='Active' AND contact_phone IS NOT NULL AND address_street_name IS NOT NULL AND business_category IN ('Garage & Parking Lot', 'Secondhand Dealer - Auto', 'Tow Truck Company', 'Car Wash')",
    }),
    cursorField: "license_creation_date",
    cursorValue: null,
    signal: "new_license",
  },
  nyc_b2b_and_specialty_dealers: {
    id: "preset_nyc_b2b",
    name: "NYC DCWP Active B2B, Medical Equipment, Appliance Service, Staffing & Storage",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "w7w3-xahh",
      name_field: "business_name",
      id_field: "license_nbr",
      vertical_field: "business_category",
      phone_field: "contact_phone",
      borough_field: "address_borough",
      where:
        "license_status='Active' AND contact_phone IS NOT NULL AND address_street_name IS NOT NULL AND business_category IN ('Electronic & Home Appliance Service Dealer', 'Dealer In Products For The Disabled', 'Employment Agency', 'Self-Storage Facility', 'Secondhand Dealer - General')",
    }),
    cursorField: "license_creation_date",
    cursorValue: null,
    signal: "new_license",
  },
  nyc_bookkeepers_and_cpas: {
    id: "preset_nyc_cpas",
    name: "NY DOS Active CPA, Bookkeeping, Accounting & Tax Service Partners",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.ny.gov",
      dataset: "n9v6-gdp6",
      name_field: "current_entity_name",
      id_field: "dos_id",
      vertical_field: "entity_type",
      borough_field: "county",
      where:
        "(upper(current_entity_name) like '%BOOKKEEPING%' OR upper(current_entity_name) like '%ACCOUNTING%' OR upper(current_entity_name) like '% CPA %' OR upper(current_entity_name) like '%CPA P%' OR upper(current_entity_name) like '%TAX SERVICE%') AND county IN ('New York','Kings','Queens','Bronx','Nassau','Westchester','Suffolk')",
    }),
    cursorField: "initial_dos_filing_date",
    cursorValue: null,
    signal: "corp_filing",
  },
  nyc_vc_and_accelerators: {
    id: "preset_nyc_vcs",
    name: "NY DOS Active Venture Capital, Seed Funds & Investment Partners",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.ny.gov",
      dataset: "n9v6-gdp6",
      name_field: "current_entity_name",
      id_field: "dos_id",
      vertical_field: "entity_type",
      borough_field: "county",
      where:
        "(upper(current_entity_name) like '%VENTURES%' OR upper(current_entity_name) like '%CAPITAL PARTNERS%' OR upper(current_entity_name) like '%VENTURE PARTNERS%' OR upper(current_entity_name) like '%SEED FUND%') AND county IN ('New York','Kings')",
    }),
    cursorField: "initial_dos_filing_date",
    cursorValue: null,
    signal: "corp_filing",
  },
  nyc_tech_and_software_startups: {
    id: "preset_nyc_tech_startups",
    name: "NY DOS Newly Formed Tech, Software & AI Startups",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.ny.gov",
      dataset: "n9v6-gdp6",
      name_field: "current_entity_name",
      id_field: "dos_id",
      vertical_field: "entity_type",
      borough_field: "county",
      where:
        "(upper(current_entity_name) like '%TECHNOLOGIES%' OR upper(current_entity_name) like '%SOFTWARE%' OR upper(current_entity_name) like '%AI LABS%' OR upper(current_entity_name) like '%SYSTEMS%') AND county IN ('New York','Kings','Queens')",
    }),
    cursorField: "initial_dos_filing_date",
    cursorValue: null,
    signal: "corp_filing",
  },
  us_nppes_medical_and_dental: {
    id: "preset_us_nppes",
    name: "US NPPES Active Dental, Medical, PT & Specialty Health Practices",
    kind: "nppes",
    config: JSON.stringify({
      state: "NY",
      city: "BROOKLYN",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "new_license",
  },
  us_sec_form_d_tech_startups: {
    id: "preset_us_sec_form_d",
    name: "SEC EDGAR Form D Newly Funded Tech Startups & Venture Offerings",
    kind: "sec_form_d",
    config: JSON.stringify({
      startdt: "2026-09-01",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "corp_filing",
  },
  // PILE-661 — free-registry revenue/pain signals.
  nyc_dob_permit_job_value: {
    id: "preset_nyc_dob_permit_job_value",
    name: "NYC DOB NOW Permit Issuance — Contractor Estimated Job Value",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.cityofnewyork.us",
      dataset: "rbx6-tga4",
      name_field: "applicant_business_name",
      id_field: "job_filing_number",
      vertical_field: "permittee_s_license_type",
      borough_field: "borough",
      address_field: "applicant_business_address",
      amount_field: "estimated_job_costs",
      amount_key: "jobValueCents",
      raw_fields: [
        "estimated_job_costs",
        "work_type",
        "job_description",
        "permit_status",
      ],
      where:
        "applicant_business_name IS NOT NULL AND estimated_job_costs IS NOT NULL",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "award",
  },
  nys_tax_warrants: {
    id: "preset_nys_tax_warrants",
    name: "NYS Dept. of Taxation & Finance Active Business Tax Warrants",
    kind: "socrata",
    config: JSON.stringify({
      domain: "data.ny.gov",
      // Active NYS Tax Warrants (filed beginning 7/1/2025); the older
      // historical file is dataset v476-w8de.
      dataset: "v7ua-z23v",
      name_field: "debtor_name_1",
      id_field: "warrant_id",
      vertical_field: "status_code",
      borough_field: "county_code",
      amount_field: "warrant_filed_amount",
      amount_key: "warrantAmountCents",
      raw_fields: [
        "status_code",
        "warrant_filed_amount",
        "warrant_filed_date",
        "warrant_satisfaction_date",
      ],
      where: "status_code='Added' AND debtor_name_1 IS NOT NULL",
    }),
    cursorField: "warrant_filed_date",
    cursorValue: null,
    signal: "violation",
  },
  nys_ucc_filings: {
    id: "preset_nys_ucc_filings",
    name: "NYS UCC Financing Statements — Secured Credit & Equipment Financing Scale",
    kind: "socrata",
    config: JSON.stringify({
      // ACRIS Personal Property Parties is the recorded UCC financing
      // statement party index (data.ny.gov has no statewide UCC feed).
      domain: "data.cityofnewyork.us",
      dataset: "nbbg-wtuz",
      name_field: "name",
      id_field: "document_id",
      vertical_field: "party_type",
      borough_field: "city",
      address_field: "address_1",
      raw_fields: ["party_type", "record_type"],
      where: "party_type='1' AND name IS NOT NULL",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "award",
  },
  irs_990_nonprofits: {
    id: "preset_irs_990_nonprofits",
    name: "ProPublica Nonprofit Explorer — NY IRS 990 Filers with Total Revenue",
    kind: "propublica_990",
    config: JSON.stringify({
      state: "NY",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "revenue_estimate",
  },
  // PILE-660 — actual city payment dollars per vendor (NYC Checkbook /
  // citywide vendor payments published via Socrata).
  nyc_checkbook: {
    id: "preset_nyc_checkbook",
    name: "NYC Checkbook Citywide Vendor Payments — Payment Dollars per Vendor",
    kind: "nyc_checkbook",
    config: JSON.stringify({
      domain: "data.ny.gov",
      dataset: "85j2-hzta",
      name_field: "vendor",
      id_field: "vendor",
      vertical_field: "fiscalyear",
      amount_field: "paymentamount",
      amount_key: "paymentAmountCents",
      raw_fields: ["fiscalyear", "quarter", "paymentamount"],
      where: "vendor IS NOT NULL AND paymentamount IS NOT NULL",
    }),
    cursorField: null,
    cursorValue: null,
    signal: "award",
  },
};

const SIGNAL_WEIGHT: Record<string, number> = {
  license_pending: 1.0,
  violation: 0.9,
  corp_filing: 0.8,
  award: 0.7,
  contact_found: 0.6,
  registration: 0.3,
};

export function scoreCandidate(c: MerchantCandidate): number {
  const w = SIGNAL_WEIGHT[c.signal] ?? 0.4;
  const days = c.signalDate
    ? Math.max(0, (Date.now() - Date.parse(c.signalDate)) / 86400000)
    : 365;
  // ~14-day decay — a filing this week outranks last month's
  return Math.round(w * Math.exp(-days / 14) * 1000) / 1000;
}

function cfg(source: MerchantSourceRow): Record<string, unknown> {
  try {
    return JSON.parse(source.config) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parses a registry dollar/number cell ("150000.00", "$5,000", 42) into a
 *  finite number, or undefined when the cell isn't numeric. */
function num(v: unknown): number | undefined {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number(v.replace(/[$,\s]/g, ""))
        : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function pullSocrata(
  source: MerchantSourceRow,
  options?: { limit?: number; offset?: number; extraWhere?: string }
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const domain = str(c.domain) ?? "data.ny.gov";
  const dataset = str(c.dataset);
  if (!dataset) throw new Error("socrata source missing dataset");
  const rawLimit = options?.limit ?? Number(c.limit ?? 500);
  const limit = Math.max(
    1,
    Math.min(500, Number.isFinite(rawLimit) ? rawLimit : 500)
  );
  const offset = Math.max(0, options?.offset ?? 0);
  const params = new URLSearchParams({
    $limit: String(limit),
    ...(offset > 0 ? { $offset: String(offset) } : {}),
  });
  const whereClauses: string[] = [];
  if (str(c.where)) whereClauses.push(`(${str(c.where)})`);
  if (options?.extraWhere) whereClauses.push(`(${options.extraWhere})`);
  if (source.cursorField) {
    whereClauses.push(
      source.cursorValue
        ? `${source.cursorField} > '${source.cursorValue}'`
        : `${source.cursorField} IS NOT NULL`
    );
    params.set("$order", `${source.cursorField} DESC`);
  }
  if (whereClauses.length > 0) {
    params.set("$where", whereClauses.join(" AND "));
  }
  const res = await fetch(
    `https://${domain}/resource/${dataset}.json?${params}`
  );
  if (!res.ok) throw new Error(`socrata ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  const nameField = str(c.name_field) ?? "name";
  const idField = str(c.id_field) ?? nameField;
  const phoneField = str(c.phone_field) ?? "contact_phone";
  const emailField = str(c.email_field) ?? "business_email";
  const boroughField = str(c.borough_field) ?? "address_borough";
  // PILE-660/661 — `raw_fields` copies named row columns into `raw`; a
  // configured `amount_field` (dollar cell) additionally lands in
  // `raw[amount_key]` as integer cents.
  const rawFields = Array.isArray(c.raw_fields)
    ? c.raw_fields.filter((f): f is string => typeof f === "string")
    : [];
  const amountField = str(c.amount_field);
  const amountKey = str(c.amount_key) ?? "amountCents";
  let maxDate: string | null = null;
  const candidates = rows.map((r) => {
    const name = str(r[nameField]);
    const id = str(r[idField]) ?? name;
    const date = source.cursorField ? str(r[source.cursorField]) : null;
    if (date && (!maxDate || date > maxDate)) maxDate = date;
    const streetLine = [
      str(r.address_building) ??
        str(r.business_house_number) ??
        str(Reflect.get(r, "house__") as unknown) ??
        str(r.building_number) ??
        str(r.dos_process_address_1),
      str(r.address_street_name) ??
        str(r.business_street_name) ??
        str(r.street_name) ??
        str(r.street) ??
        str(r.dos_process_address_2),
    ]
      .filter(Boolean)
      .join(" ");
    const composedAddress = [
      streetLine ||
        str(r.actual_address_of_premises) ||
        str(r.address) ||
        str(r[str(c.address_field) ?? "address"]) ||
        str(r.debtor_address_2) ||
        str(r.debtor_address_1),
      str(r.address_city) ??
        str(r.license_business_city) ??
        str(r.dos_process_city) ??
        str(r.city),
      str(r.address_state) ??
        str(r.business_state) ??
        str(r.dos_process_state) ??
        str(r.state) ??
        str(r.state_name),
      str(r.address_zip) ??
        str(r.business_zip_code) ??
        str(r.dos_process_zip) ??
        str(r.zip_code) ??
        str(r.postcode),
    ]
      .filter(Boolean)
      .join(", ");
    const rawEmail = (
      str(r[emailField]) ??
      str(r.business_email) ??
      str(r.email)
    )?.toLowerCase();
    const ownerFirst = str(r.first_name) ?? str(r.permittee_s_first_name);
    const ownerLast = str(r.last_name) ?? str(r.permittee_s_last_name);
    const processPerson =
      str(r.dos_process_name) ?? str(r.registered_agent_name);
    const validProcessPerson =
      processPerson &&
      name &&
      processPerson.toUpperCase() !== name.toUpperCase() &&
      !/\b(LLC|INC|CORP|PLLC|PC|C\/O|REGISTERED AGENT|CORPORATION SERVICE)\b/i.test(
        processPerson
      )
        ? processPerson
        : null;
    const ownerName =
      [ownerFirst, ownerLast].filter(Boolean).join(" ") ||
      validProcessPerson ||
      null;
    let raw: Record<string, unknown> | null = null;
    if (rawFields.length > 0 || amountField) {
      raw = {};
      for (const f of rawFields) {
        if (r[f] !== undefined) raw[f] = r[f];
      }
      const amountDollars = amountField ? num(r[amountField]) : undefined;
      if (amountDollars !== undefined) {
        raw[amountKey] = Math.round(amountDollars * 100);
      }
    }
    return {
      name: name ?? "unknown",
      externalId: `socrata:${dataset}:${id}`,
      domain:
        str(r[str(c.domain_field) ?? "website"]) ??
        deriveDomainFromEmail(rawEmail),
      address: composedAddress || null,
      phone:
        str(r[phoneField]) ??
        str(r.business_phone_number) ??
        str(Reflect.get(r, "permittee_s_phone__") as unknown) ??
        str(r.phone),
      email: rawEmail ?? null,
      ownerName,
      neighborhood:
        str(r[boroughField]) ??
        str(r.borough) ??
        str(r.county) ??
        str(r.license_business_city) ??
        str(r.dos_process_city) ??
        str(r.city),
      vertical: str(r[str(c.vertical_field) ?? "description"]),
      signal: source.signal,
      signalDate: date,
      evidenceUri: `https://${domain}/resource/${dataset}.json?${idField}=${encodeURIComponent(String(id ?? ""))}`,
      estMonthlyVolumeCents:
        raw && typeof raw[amountKey] === "number"
          ? Math.round((raw[amountKey] as number) / 12)
          : null,
      raw,
    };
  });
  return { candidates, newCursor: maxDate };
}

async function pullUsaspending(
  source: MerchantSourceRow
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const filters: Record<string, unknown> = {};
  if (Array.isArray(c.naics) && c.naics.length)
    filters.naics_codes = { require: c.naics };
  if (str(c.state))
    filters.recipient_locations = [{ state: c.state, country: "USA" }];
  if (str(c.keyword)) filters.recipient_search_text = [c.keyword];

  // PILE-660 — `endpoint: "spending_by_award"` hits the award search so each
  // candidate carries real contract dollars (`raw.awardAmountCents`) plus an
  // estMonthlyVolumeCents proxy (annual award / 12).
  if (str(c.endpoint) === "spending_by_award") {
    const res = await fetch(
      "https://api.usaspending.gov/api/v2/search/spending_by_award/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filters: {
            ...filters,
            award_type_codes: ["A", "B", "C", "D"],
          },
          fields: [
            "Award ID",
            "Recipient Name",
            "Award Amount",
            "Start Date",
            "Awarding Agency",
          ],
          limit: 100,
        }),
      }
    );
    if (!res.ok) throw new Error(`usaspending ${res.status}`);
    const data = (await res.json()) as {
      results?: Record<string, unknown>[];
    };
    const candidates: MerchantCandidate[] = (data.results ?? []).map((r) => {
      const name = str(r["Recipient Name"]) ?? "unknown";
      const awardDollars = num(r["Award Amount"]);
      const awardAmountCents =
        awardDollars !== undefined ? Math.round(awardDollars * 100) : undefined;
      const awardId = str(r["Award ID"]);
      return {
        name,
        externalId: `usaspending:${awardId ?? name}`,
        signal: source.signal,
        signalDate: str(r["Start Date"]),
        estMonthlyVolumeCents:
          awardAmountCents !== undefined
            ? Math.round(awardAmountCents / 12)
            : null,
        raw: { ...r, awardAmountCents: awardAmountCents ?? null },
        evidenceUri: `https://www.usaspending.gov/award/${encodeURIComponent(awardId ?? "")}`,
      };
    });
    return { candidates, newCursor: null };
  }

  const res = await fetch("https://api.usaspending.gov/api/v2/recipient/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filters, limit: 500 }),
  });
  if (!res.ok) throw new Error(`usaspending ${res.status}`);
  const data = (await res.json()) as {
    results?: { name?: string; uei?: string; duns?: string; amount?: number }[];
  };
  const candidates: MerchantCandidate[] = (data.results ?? []).map((r) => {
    const awardAmountCents =
      typeof r.amount === "number" && Number.isFinite(r.amount)
        ? Math.round(r.amount * 100)
        : undefined;
    return {
      name: r.name ?? "unknown",
      externalId: `usaspending:${r.uei ?? r.duns ?? r.name}`,
      signal: source.signal,
      signalDate: null,
      estMonthlyVolumeCents:
        awardAmountCents !== undefined
          ? Math.round(awardAmountCents / 12)
          : null,
      raw:
        awardAmountCents !== undefined
          ? { awardAmountCents, amount: r.amount }
          : null,
      evidenceUri: `https://www.usaspending.gov/recipient/${r.uei ?? ""}`,
    };
  });
  return { candidates, newCursor: null };
}

async function pullOpencorporates(
  source: MerchantSourceRow
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const params = new URLSearchParams({
    q: str(c.query) ?? "",
    format: "json",
    per_page: "50",
    order: "score",
  });
  if (str(c.jurisdiction))
    params.set("jurisdiction_code", str(c.jurisdiction)!);
  const res = await fetch(
    `https://api.opencorporates.com/v0.4/companies/search?${params}`
  );
  if (!res.ok) throw new Error(`opencorporates ${res.status}`);
  const data = (await res.json()) as {
    results?: {
      companies?: { company?: Record<string, unknown> }[];
    };
  };
  const companies = data.results?.companies ?? [];
  const candidates = companies.map((entry) => {
    const co = entry.company ?? {};
    return {
      name: str(co.name) ?? "unknown",
      externalId: `opencorporates:${str(co.company_number) ?? str(co.name)}`,
      domain: null,
      address:
        [str(co.current_address), str(co.registered_address_in_full)].find(
          Boolean
        ) ?? null,
      vertical: str(co.company_type),
      signal: source.signal,
      signalDate: str(co.incorporation_date),
      evidenceUri: str(co.opencorporates_url),
    };
  });
  return { candidates, newCursor: null };
}

async function pullSam(
  source: MerchantSourceRow,
  env?: Record<string, string | undefined>
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const key = env?.SAM_API_KEY;
  if (!key) throw new Error("SAM_API_KEY not configured");
  const c = cfg(source);
  const params = new URLSearchParams({ api_key: key });
  if (str(c.keyword)) params.set("legalBusinessName", str(c.keyword)!);
  if (str(c.naics)) params.set("naicsCode", str(c.naics)!);
  if (str(c.state))
    params.set("physicalAddressStateOrProvinceCode", str(c.state)!);
  const res = await fetch(
    `https://api.sam.gov/entity-information/v3/entities?${params}`
  );
  if (!res.ok) throw new Error(`sam ${res.status}`);
  const data = (await res.json()) as {
    entityData?: {
      entityRegistration?: {
        legalBusinessName?: string;
        ueiSAM?: string;
        cageCode?: string;
      };
      coreData?: {
        physicalAddress?: {
          addressLine1?: string;
          city?: string;
          stateOrProvinceCode?: string;
        };
      };
    }[];
  };
  const candidates = (data.entityData ?? []).map((e) => {
    const reg = e.entityRegistration ?? {};
    const addr = e.coreData?.physicalAddress ?? {};
    return {
      name: reg.legalBusinessName ?? "unknown",
      externalId: `sam:${reg.ueiSAM ?? reg.cageCode ?? reg.legalBusinessName}`,
      address:
        [addr.addressLine1, addr.city, addr.stateOrProvinceCode]
          .filter(Boolean)
          .join(", ") || null,
      signal: source.signal,
      signalDate: null,
      evidenceUri: `https://sam.gov/entity/${reg.ueiSAM ?? ""}`,
    };
  });
  return { candidates, newCursor: null };
}

function xmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`, "i");
  const m = re.exec(xml);
  return m?.[1]?.trim() || null;
}

async function pullNppes(
  source: MerchantSourceRow,
  options?: { limit?: number; offset?: number; extraWhere?: string }
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const state = str(c.state) ?? "NY";
  const city = options?.extraWhere
    ? options.extraWhere.replace(/^.*='([^']+)'.*$/, "$1")
    : (str(c.city) ?? "BROOKLYN");
  const limit = Math.max(1, Math.min(200, options?.limit ?? 15));
  const skip = Math.max(0, options?.offset ?? 0);
  const params = new URLSearchParams({
    version: "2.1",
    enumeration_type: "NPI-2",
    state,
    city,
    limit: String(limit),
    skip: String(skip),
  });
  const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params}`);
  if (!res.ok) throw new Error(`nppes ${res.status}`);
  const body = (await res.json()) as {
    results?: Array<{
      number?: string;
      basic?: {
        organization_name?: string;
        authorized_official_first_name?: string;
        authorized_official_last_name?: string;
        authorized_official_telephone_number?: string;
        authorized_official_title_or_position?: string;
        enumeration_date?: string;
      };
      addresses?: Array<{
        address_purpose?: string;
        address_1?: string;
        city?: string;
        state?: string;
        postal_code?: string;
        telephone_number?: string;
      }>;
      taxonomies?: Array<{ desc?: string; primary?: boolean }>;
    }>;
  };
  const candidates: MerchantCandidate[] = (body.results ?? []).map((r) => {
    const npi = r.number ?? "unknown";
    const basic = r.basic ?? {};
    const loc =
      (r.addresses ?? []).find((a) => a.address_purpose === "LOCATION") ??
      r.addresses?.[0];
    const tax =
      (r.taxonomies ?? []).find((t) => t.primary) ?? r.taxonomies?.[0];
    const ownerName =
      [
        basic.authorized_official_first_name,
        basic.authorized_official_last_name,
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || null;
    const phone =
      str(basic.authorized_official_telephone_number) ??
      str(loc?.telephone_number);
    const address = [
      loc?.address_1,
      loc?.city,
      loc?.state,
      loc?.postal_code?.slice(0, 5),
    ]
      .filter(Boolean)
      .join(", ");
    return {
      name: (basic.organization_name ?? "unknown").replace(/^\.+/, "").trim(),
      externalId: `nppes:${npi}`,
      domain: null,
      address: address || null,
      phone,
      email: null,
      ownerName,
      neighborhood: loc?.city ?? city,
      vertical: tax?.desc ?? "Medical, Dental & DME (20% Explore)",
      signal: source.signal,
      signalDate: basic.enumeration_date ?? null,
      evidenceUri: `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${encodeURIComponent(npi)}`,
    };
  });
  return { candidates, newCursor: null };
}

async function pullSecFormD(
  source: MerchantSourceRow,
  options?: { limit?: number; offset?: number }
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const startdt = str(c.startdt) ?? "2026-09-01";
  const limit = Math.max(1, Math.min(25, options?.limit ?? 10));
  const from = Math.max(0, options?.offset ?? 0);
  const params = new URLSearchParams({
    forms: "D",
    startdt,
    from: String(from),
  });
  const headers = { "User-Agent": "VortexNYC Ops@vortex.nyc" };
  const res = await fetch(
    `https://efts.sec.gov/LATEST/search-index?${params}`,
    { headers }
  );
  if (!res.ok) throw new Error(`sec_form_d ${res.status}`);
  const body = (await res.json()) as {
    hits?: {
      hits?: Array<{
        _id?: string;
        _source?: {
          ciks?: string[];
          adsh?: string;
          display_names?: string[];
          biz_locations?: string[];
          file_date?: string;
        };
      }>;
    };
  };
  const hits = (body.hits?.hits ?? []).slice(0, limit);
  const candidates: MerchantCandidate[] = await Promise.all(
    hits.map(async (h) => {
      const src =
        (Reflect.get(h, "_source") as
          | {
              ciks?: string[];
              adsh?: string;
              display_names?: string[];
              biz_locations?: string[];
              file_date?: string;
            }
          | undefined) ?? {};
      const hitId = Reflect.get(h, "_id") as string | undefined;
      const adsh = src.adsh ?? hitId?.split(":")[0] ?? "unknown";
      const cikRaw = src.ciks?.[0] ?? "";
      const cikInt = cikRaw.replace(/^0+/, "");
      const adshClean = adsh.replace(/-/g, "");
      const xmlUrl =
        cikInt && adshClean
          ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${adshClean}/primary_doc.xml`
          : null;

      let entityName =
        (src.display_names?.[0] ?? "unknown")
          .replace(/\s*\(CIK\s*\d+\)\s*$/i, "")
          .trim() || "unknown";
      let phone: string | null = null;
      let address: string | null = src.biz_locations?.[0] ?? null;
      let ownerName: string | null = null;
      let industryGroup: string | null = null;

      if (xmlUrl) {
        try {
          const xmlRes = await fetch(xmlUrl, {
            headers,
            signal: AbortSignal.timeout(2500),
          });
          if (xmlRes.ok) {
            const xml = (await xmlRes.text()).slice(0, 32_768);
            entityName = xmlTag(xml, "entityName") ?? entityName;
            phone = xmlTag(xml, "issuerPhoneNumber");
            const street1 = xmlTag(xml, "street1");
            const city = xmlTag(xml, "city");
            const state = xmlTag(xml, "stateOrCountry");
            const zip = xmlTag(xml, "zipCode");
            if (street1 || city) {
              address = [street1, city, state, zip].filter(Boolean).join(", ");
            }
            const first = xmlTag(xml, "firstName");
            const last = xmlTag(xml, "lastName");
            if (first || last) {
              ownerName = [first, last].filter(Boolean).join(" ");
            }
            industryGroup = xmlTag(xml, "industryGroupType");
          }
        } catch {
          /* fallback to index metadata */
        }
      }

      const isFund =
        /pooled investment|venture capital|private equity/i.test(
          industryGroup ?? ""
        ) || /\b(fund|ventures|capital partners|lp)\b/i.test(entityName);

      return {
        name: entityName,
        externalId: `sec_form_d:${adsh}`,
        domain: null,
        address,
        phone,
        email: null,
        ownerName,
        neighborhood: src.biz_locations?.[0] ?? null,
        vertical: isFund ? "VC / Fund Partner" : "Tech / AI / SaaS Startup",
        signal: source.signal,
        signalDate: src.file_date ?? null,
        evidenceUri:
          xmlUrl ??
          `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(adsh)}`,
      };
    })
  );
  return { candidates, newCursor: null };
}

const PLACES_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryType,places.rating,places.userRatingCount,nextPageToken";

interface GooglePlaceV1 {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
}

function placeDomain(websiteUri: string | null | undefined): string | null {
  if (!websiteUri) return null;
  try {
    return (
      new URL(websiteUri).hostname.replace(/^www\./i, "").toLowerCase() || null
    );
  } catch {
    return null;
  }
}

/** PILE-663 — Google Places (New) Text Search source. Config:
 *  `{ textQuery?, locationBias?, includedType?, apiKey?, maxResults?, url? }`.
 *  `locationBias` accepts a JSON Places LocationBias object or a `lat,lng`
 *  string (wrapped as a 5km circle). When `url` is set, falls back to a
 *  legacy GET (e.g. a placesearch proxy) and maps the classic `results`
 *  shape. Places land as `gplace:<id>` candidates carrying rating +
 *  userRatingCount in `raw` for the foot-traffic revenue proxy. */
async function pullGooglePlacesSource(
  source: MerchantSourceRow,
  env?: Record<string, string | undefined>
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const apiKey = str(c.apiKey) ?? env?.GOOGLE_PLACES_API_KEY ?? null;

  // Legacy GET path — a prebuilt placesearch/proxy URL returning the classic
  // `{ results: [...] }` shape.
  if (str(c.url)) {
    const res = await fetch(str(c.url)!, {
      headers: apiKey ? { "X-Goog-Api-Key": apiKey } : {},
    });
    if (!res.ok) throw new Error(`places ${res.status}`);
    const data = (await res.json()) as {
      results?: Array<{
        place_id?: string;
        name?: string;
        formatted_address?: string;
        formatted_phone_number?: string;
        international_phone_number?: string;
        website?: string;
        types?: string[];
        rating?: number;
        user_ratings_total?: number;
      }>;
    };
    const candidates: MerchantCandidate[] = (data.results ?? []).map((p) => ({
      name: p.name ?? "unknown",
      externalId: `gplace:${p.place_id ?? p.name}`,
      domain: placeDomain(p.website),
      address: p.formatted_address ?? null,
      phone: p.formatted_phone_number ?? p.international_phone_number ?? null,
      vertical: p.types?.[0] ?? null,
      signal: source.signal,
      signalDate: null,
      evidenceUri: `https://www.google.com/maps/place/?q=place_id:${p.place_id ?? ""}`,
      raw: {
        rating: p.rating ?? null,
        userRatingCount: p.user_ratings_total ?? null,
      },
    }));
    return { candidates, newCursor: null };
  }

  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not configured");
  const textQuery = str(c.textQuery) ?? str(c.query);
  if (!textQuery) throw new Error("places source missing textQuery");
  const maxResults = Math.max(1, Math.min(20, num(c.maxResults) ?? 20));
  const body: Record<string, unknown> = {
    textQuery,
    maxResultCount: maxResults,
  };
  if (str(c.includedType)) body.includedType = str(c.includedType);
  const biasRaw = str(c.locationBias);
  if (biasRaw) {
    try {
      body.locationBias = JSON.parse(biasRaw) as unknown;
    } catch {
      const [lat, lng] = biasRaw.split(",").map((p) => Number(p.trim()));
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        body.locationBias = {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: num(c.radiusMeters) ?? 5000,
          },
        };
      }
    }
  }
  const res = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`places ${res.status}`);
  const data = (await res.json()) as {
    places?: GooglePlaceV1[];
    nextPageToken?: string;
  };
  const candidates: MerchantCandidate[] = (data.places ?? []).map((p) => ({
    name: p.displayName?.text ?? "unknown",
    externalId: `gplace:${p.id ?? p.displayName?.text ?? "unknown"}`,
    domain: placeDomain(p.websiteUri),
    address: p.formattedAddress ?? null,
    phone: p.nationalPhoneNumber ?? null,
    vertical: p.primaryType ?? null,
    signal: source.signal,
    signalDate: null,
    evidenceUri: `https://places.googleapis.com/v1/places/${p.id ?? ""}`,
    raw: {
      rating: p.rating ?? null,
      userRatingCount: p.userRatingCount ?? null,
    },
  }));
  return { candidates, newCursor: data.nextPageToken ?? null };
}

/** PILE-661 — ProPublica Nonprofit Explorer (IRS 990) source. Config:
 *  `{ state?, q?, c_code?, maxResults? }`. Returns NY nonprofits carrying
 *  real `totrevenue` dollars in `raw.totalRevenueDollars` and an
 *  estMonthlyVolumeCents proxy (annual revenue / 12). */
async function pullPropublica990(
  source: MerchantSourceRow,
  options?: { limit?: number; offset?: number }
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const state = str(c.state) ?? "NY";
  const params = new URLSearchParams({ "state[id]": state });
  if (str(c.q)) params.set("q", str(c.q)!);
  if (str(c.c_code)) params.set("c_code[id]", str(c.c_code)!);
  const page = Math.floor(Math.max(0, options?.offset ?? 0) / 25);
  if (page > 0) params.set("page", String(page));
  const res = await fetch(
    `https://projects.propublica.org/nonprofits/api/v2/search.json?${params}`
  );
  if (!res.ok) throw new Error(`propublica_990 ${res.status}`);
  const data = (await res.json()) as {
    organizations?: Array<{
      ein?: string | number;
      name?: string;
      city?: string;
      state?: string;
      ntee_code?: string;
      totrevenue?: number | null;
      totfuncexpns?: number | null;
      pdf_url?: string | null;
      updated?: string;
    }>;
  };
  let orgs = data.organizations ?? [];
  const maxResults = num(c.maxResults);
  if (maxResults !== undefined) orgs = orgs.slice(0, maxResults);
  const candidates: MerchantCandidate[] = orgs.map((o) => {
    const ein = o.ein !== undefined ? String(o.ein) : null;
    const revenueDollars =
      typeof o.totrevenue === "number" && Number.isFinite(o.totrevenue)
        ? o.totrevenue
        : null;
    return {
      name: o.name ?? "unknown",
      externalId: `propublica990:${ein ?? o.name}`,
      domain: null,
      address: [o.city, o.state].filter(Boolean).join(", ") || null,
      phone: null,
      email: null,
      ownerName: null,
      neighborhood: o.city ?? null,
      vertical: "Nonprofit (IRS 990)",
      signal: source.signal,
      signalDate: o.updated ?? null,
      evidenceUri: ein
        ? `https://projects.propublica.org/nonprofits/organizations/${ein}`
        : null,
      estMonthlyVolumeCents:
        revenueDollars !== null
          ? Math.round((revenueDollars * 100) / 12)
          : null,
      raw: {
        ein,
        nteeCode: o.ntee_code ?? null,
        totalRevenueDollars: revenueDollars,
        totalFunctionalExpensesDollars: o.totfuncexpns ?? null,
        pdfUrl: o.pdf_url ?? null,
      },
    };
  });
  return { candidates, newCursor: null };
}

export async function pullSource(
  source: MerchantSourceRow,
  env?: Record<string, string | undefined>,
  options?: { limit?: number; offset?: number; extraWhere?: string }
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  switch (source.kind) {
    case "socrata":
      return pullSocrata(source, options);
    case "nyc_checkbook":
      // PILE-660 — NYC Checkbook / citywide vendor payments ride the same
      // Socrata puller; the config's amount_field lands in
      // `raw.paymentAmountCents`.
      return pullSocrata(source, options);
    case "propublica_990":
      return pullPropublica990(source, options);
    case "places":
      return pullGooglePlacesSource(source, env);
    case "nppes":
      return pullNppes(source, options);
    case "sec_form_d":
      return pullSecFormD(source, options);
    case "usaspending":
      return pullUsaspending(source);
    case "opencorporates":
      return pullOpencorporates(source);
    case "sam":
      return pullSam(source, env);
    default:
      throw new Error(`unsupported source kind: ${source.kind}`);
  }
}
