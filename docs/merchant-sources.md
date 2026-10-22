# Merchant sources — signal-based intake

The discovery tier. Instead of one agent polling every feed, each feed is a
registered **source**; a collector pulls deltas, normalizes rows into
candidates, scores them, and upserts into the CRM. Agents read the scored
queue — never the firehose.

## How it works

```
merchant_sources (registry)
       │  collect_source — pull deltas since cursor
       ▼
MerchantCandidate { name, external_id, domain, address, vertical,
                    signal, signal_date, evidence_uri }
       │  score = signal_weight × exp(-days/14)  (14-day decay)
       ▼
customers (deduped by external_id, ranked by priority_score)
```

Score bands drive routing: `license_pending` (opening now) > `violation` >
`corp_filing` > `award` > `contact_found` > `registration`. Recency decays —
a filing this week outranks last quarter's.

## Tools

| Tool             | What it does                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `source_add`     | Register a feed: name, kind, config (field map), cursor field, signal, cadence           |
| `source_list`    | List registered sources                                                                  |
| `source_collect` | Pull one source (or all enabled) → candidates → scored customers; records a `market_run` |

## Kinds + configs

| kind             | config                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socrata`        | `{domain, dataset, name_field, id_field, domain_field?, address_field?, vertical_field?}` — works on any Socrata domain (`data.ny.gov`, `data.cityofnewyork.us`, state portals) |
| `usaspending`    | `{naics?: string[], state?, keyword?}` — federal award recipients                                                                                                               |
| `opencorporates` | `{query, jurisdiction?}` — business registry search                                                                                                                             |
| `sam`            | `{keyword?, naics?, state?}` — SAM.gov vendors (needs `SAM_API_KEY`)                                                                                                            |

## Source descriptors (example feeds)

```ts
source_add({
  name: "nys-sla-pending",
  kind: "socrata",
  config: {
    domain: "data.ny.gov",
    dataset: "f8i8-k2gm",
    name_field: "legalname",
    id_field: "application_id",
    vertical_field: "description",
  },
  cursorField: "received_date",
  signal: "license_pending",
  cadence: "daily",
});

source_add({
  name: "nys-corp-filings",
  kind: "socrata",
  config: {
    domain: "data.ny.gov",
    dataset: "63wc-4exh",
    name_field: "entity_name",
    id_field: "dos_id",
  },
  cursorField: "filing_date",
  signal: "corp_filing",
});
```

## Doctrine

- Sources are dumb adapters — a new feed is a config row, not code.
- Collection is mechanical — the pull is deterministic; agents decide when to run it and what to do with the queue.
- The queue re-sorts itself by timing — recency decays the score; the list is never "done."
- Suppression is routing — low-signal candidates get logged-and-dropped, not nurtured.
- Volume matches action capacity — the score band decides what Grokbot even sees.
