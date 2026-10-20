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
  runCount: number;
}

export interface MerchantCandidate {
  name: string;
  externalId: string;
  domain?: string | null;
  address?: string | null;
  vertical?: string | null;
  signal: string;
  signalDate?: string | null;
  evidenceUri?: string | null;
}

const SIGNAL_WEIGHT: Record<string, number> = {
  license_pending: 1.0,
  violation: 0.9,
  corp_filing: 0.8,
  award: 0.7,
  contact_found: 0.6,
  registration: 0.3,
};

/** SSRF guard for lane-reachable fetch paths — loopback, unspecified
 *  (0.0.0.0), RFC1918, CGNAT (100.64/10), link-local (cloud metadata),
 *  benchmarking/documentation ranges (198.18/15, TEST-NET-1/2/3,
 *  192.0.0/24, 6to4 anycast), multicast/reserved (224/4 + 240/4), and
 *  IPv6 loopback/mapped/local/tunneled (6to4, Teredo) addresses are
 *  never valid feed endpoints. Lane-writable source configs and tool
 *  inputs build URLs from user-controlled hosts, so every such path
 *  checks.
 *  Residual: this vets the hostname, not the DNS answer — a public
 *  name that resolves to a private address (nip.io, split-horizon
 *  DNS) still passes; workerd exposes no resolved-IP hook to close
 *  that gap. Redirect hops are re-vetted in fetchPublic so a public
 *  feed can't 302 a request into a blocked host. */
export const BLOCKED_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(18|19)\.|192\.0\.(0|2)\.|192\.88\.99\.|198\.51\.100\.|203\.0\.113\.|2(2[4-9]|[3-5]\d)\.|0\.\d+\.\d+\.\d+$|\[::|\[64:ff9b:|\[f|\[2002:|\[2001:0*:|[0:]+$)/i;

export function assertPublicHost(hostname: string): void {
  // Parse before testing — inputs like "legit.com@127.0.0.1" pass a
  // raw-string check while the URL's real host is the blocked one.
  let parsed: URL;
  try {
    parsed = new URL(
      hostname.includes("://") ? hostname : `https://${hostname}`
    );
  } catch {
    throw new Error("https public hosts only");
  }
  // The port is part of the probe surface — `public.gov:22` reaches
  // services the host guard never meant to expose. An empty port is
  // the https default (443), the only one allowed.
  if (parsed.port !== "" || BLOCKED_HOSTS.test(parsed.hostname)) {
    throw new Error("https public hosts only");
  }
}

/** Host-checked fetch for lane-controlled URLs — https only, redirects
 *  followed manually with every hop's host re-vetted through
 *  assertPublicHost so a public feed domain can't bounce the lane into
 *  a private endpoint. Request headers forward only while the hop
 *  stays on the first URL's origin (no credential leak to a redirect
 *  target). */
export async function fetchPublic(
  url: string,
  init?: RequestInit,
  maxRedirects = 5
): Promise<Response> {
  const firstOrigin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:") {
      throw new Error("https public hosts only");
    }
    // `host` carries a non-default port, so the port guard vets every
    // hop too — `public.gov:22` can't slip through on hostname alone.
    assertPublicHost(parsed.host);
    const res = await fetch(current, {
      ...init,
      redirect: "manual",
      headers: parsed.origin === firstOrigin ? init?.headers : undefined,
    });
    const location =
      res.status >= 300 && res.status < 400
        ? res.headers.get("location")
        : null;
    if (!location) return res;
    if (hop === maxRedirects) throw new Error("too many redirects");
    current = new URL(location, current).toString();
  }
  throw new Error("unreachable");
}

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
  source: MerchantSourceRow
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  const c = cfg(source);
  const domain = str(c.domain) ?? "data.ny.gov";
  assertPublicHost(domain);
  const dataset = str(c.dataset);
  if (!dataset) throw new Error("socrata source missing dataset");
  const params = new URLSearchParams({ $limit: "500" });
  if (source.cursorField) {
    // cursorField lands as a bare identifier in $where/$order and
    // cursorValue inside a quoted literal — both are lane-writable, so
    // constrain the identifier shape and escape the literal.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.cursorField)) {
      throw new Error(`socrata cursor field not an identifier`);
    }
    params.set(
      "$where",
      source.cursorValue
        ? `${source.cursorField} > '${source.cursorValue.replaceAll("'", "''")}'`
        : `${source.cursorField} IS NOT NULL`
    );
    params.set("$order", `${source.cursorField} DESC`);
  }
  const res = await fetchPublic(
    `https://${domain}/resource/${dataset}.json?${params}`
  );
  if (!res.ok) throw new Error(`socrata ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  const nameField = str(c.name_field) ?? "name";
  const idField = str(c.id_field) ?? nameField;
  let maxDate: string | null = null;
  const candidates = rows.map((r) => {
    const name = str(r[nameField]);
    const id = str(r[idField]) ?? name;
    const date = source.cursorField ? str(r[source.cursorField]) : null;
    if (date && (!maxDate || date > maxDate)) maxDate = date;
    return {
      name: name ?? "unknown",
      externalId: `socrata:${dataset}:${id}`,
      domain: str(r[str(c.domain_field) ?? "website"]),
      address:
        str(r[str(c.address_field) ?? "address"]) ??
        ([str(r.actual_address_of_premises), str(r.city), str(r.state_name)]
          .filter(Boolean)
          .join(", ") ||
          null),
      vertical: str(r[str(c.vertical_field) ?? "description"]),
      signal: source.signal,
      signalDate: date,
      evidenceUri: `https://${domain}/resource/${dataset}.json?${idField}=${id}`,
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
  env?: Record<string, string | undefined>
): Promise<{ candidates: MerchantCandidate[]; newCursor: string | null }> {
  switch (source.kind) {
    case "socrata":
      return pullSocrata(source);
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
