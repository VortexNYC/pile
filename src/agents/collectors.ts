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
  | "nyc_tech_and_software_startups";

export type LeadSheetKey =
  | "trades"
  | "tech"
  | "partners_accounting"
  | "partners_vc"
  | "exploration"
  | "excluded_pos";

export interface MerchantLeadClassification {
  sheetKey: LeadSheetKey;
  categoryLabel: string;
  vortexWedge: string;
}

export function classifyMerchantLead(input: {
  name?: string | null;
  vertical?: string | null;
  source?: string | null;
}): MerchantLeadClassification {
  const v = (input.vertical ?? "").toLowerCase();
  const n = (input.name ?? "").toLowerCase();
  const s = (input.source ?? "").toLowerCase();

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

  if (
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
    )
  ) {
    return {
      sheetKey: "excluded_pos",
      categoryLabel: "Restaurant / POS (Excluded)",
      vortexWedge: "Excluded — Requires Restaurant POS",
    };
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
    v.includes("pharmacy")
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
  let maxDate: string | null = null;
  const candidates = rows.map((r) => {
    const name = str(r[nameField]);
    const id = str(r[idField]) ?? name;
    const date = source.cursorField ? str(r[source.cursorField]) : null;
    if (date && (!maxDate || date > maxDate)) maxDate = date;
    const streetLine = [
      str(r.address_building) ??
        str(r.business_house_number) ??
        str(r.house__) ??
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
      streetLine || str(r.actual_address_of_premises) || str(r.address),
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
    return {
      name: name ?? "unknown",
      externalId: `socrata:${dataset}:${id}`,
      domain:
        str(r[str(c.domain_field) ?? "website"]) ??
        deriveDomainFromEmail(rawEmail),
      address:
        (composedAddress || str(r[str(c.address_field) ?? "address"])) ?? null,
      phone:
        str(r[phoneField]) ??
        str(r.business_phone_number) ??
        str(r.permittee_s_phone__) ??
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
  const res = await fetch("https://api.usaspending.gov/api/v2/recipient/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filters, limit: 500 }),
  });
  if (!res.ok) throw new Error(`usaspending ${res.status}`);
  const data = (await res.json()) as {
    results?: { name?: string; uei?: string; duns?: string; amount?: number }[];
  };
  const candidates = (data.results ?? []).map((r) => ({
    name: r.name ?? "unknown",
    externalId: `usaspending:${r.uei ?? r.duns ?? r.name}`,
    signal: source.signal,
    signalDate: null,
    evidenceUri: `https://www.usaspending.gov/recipient/${r.uei ?? ""}`,
  }));
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

export async function pullSource(
  source: MerchantSourceRow,
  env?: Record<string, string | undefined>,
  options?: { limit?: number; offset?: number; extraWhere?: string }
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  switch (source.kind) {
    case "socrata":
      return pullSocrata(source, options);
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
