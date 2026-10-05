# Status page

Public status for `pile.nyc` lives at **https://status.pile.nyc**
(fallback while the custom domain is pending: https://pile.openstatus.dev).
It is hosted on OpenStatus in a separate Pile workspace (page id `5671`).

Owner: **Pile**. This is a Pile-internal service with no Vortex dependency.
The incident lead from `docs/incident-response.md` publishes updates here.

## Decision: OpenStatus, not a Pile-owned worker

| Option                                          | For                                                                     | Against                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **OpenStatus (hosted, open source)** — chosen   | Probes run off Cloudflare from 5 regions; zero code; incidents UI + API | Third-party account; one more secret                                                                          |
| Pile worker reading `/health` + incidents table | Fully owned, same stack                                                 | Runs on the same Cloudflare account it reports on — a CF or account outage takes the status page down with it |

A status page that shares fate with the thing it watches is not a status
page. OpenStatus is open source, so self-hosting stays an exit if the
hosted plan ever stops fitting. Revisit only if that happens.

## Health check

One monitor, `pile.nyc API` (OpenStatus id `11888`):

- `GET https://pile.nyc/health`, every **1 minute**
- Regions: `iad`, `sjc`, `fra`, `syd`, `nrt`
- Passes on HTTP `200`

`/health` (`src/platform/health.ts`) probes D1 and the workspace Durable
Object, and reports email/compute config presence. It returns `200` for
`healthy` **and** `degraded`, and `503` only when every check fails. So
the public page shows **hard-down only** — that is intentional for v1:
missing email or compute config is an operator problem, not an outage
customers need to read about. Degraded states are handled on the normal
S3 track.

`/status` on the API is a 308 to `/health` for scripts; humans go to
`status.pile.nyc`.

## Uptime target

**99.9% monthly** for the `pile.nyc API` monitor (about 43 minutes of
downtime per 30 days). This is an internal objective, not a contractual
SLA. Missing it in a month gets a Pile issue with the cause and a fix.

## Publishing incidents

Post on the status page whenever an incident is **customer-visible**:

| Sev (see `incident-response.md`) | Post?                                   | When                           |
| -------------------------------- | --------------------------------------- | ------------------------------ |
| S1                               | Yes                                     | Within 30 minutes of declaring |
| S2                               | Only if customer-visible                | Within 1 hour                  |
| S3                               | Only if user-facing errors are elevated | When confirmed                 |

Updates follow OpenStatus states — `investigating` → `identified` →
`monitoring` → `resolved` — and each one says what users see and what
we are doing, in one or two sentences. Post a new update at least every
hour until resolved. Never put secrets, workspace names, or customer
data on the public page; S1 detail goes in the direct comms from
`incident-response.md`.

Scheduled maintenance that can cause downtime gets a maintenance window
on the page before it starts.

## Access

- Dashboard: OpenStatus, Pile workspace.
- API key: Veil, entry `openstatus`.
- DNS: `status.pile.nyc` is a CNAME to `cname.vercel-dns.com`. Vercel
  domain verification needs the TXT record shown in OpenStatus →
  Settings → Custom Domain; until it is added, TLS on `status.pile.nyc`
  fails and the `pile.openstatus.dev` URL is the one to share.
