# Compliance self-assessment

> **System of record:** the living register tracks in CompAI. This file
> is the point-in-time self-assessment — update CompAI, not this doc,
> when a gap moves.

Scope: Pile, self-hostable by design — for self-hosted deployments the
deployer is the data controller and this doc is a template. For Vortex's
own hosted deployment (`pile.nyc`), this is the assessment. Audience:
the operator, then any auditor or compliance platform we adopt.

Method: SOC 2 Trust Services Criteria as the frame. For each criterion:
what exists today, evidence pointer, verdict. "N/A" means genuinely
inapplicable, not "didn't bother."

Legend: **met** / **partial** / **gap** / **N/A**.

## CC1–CC5 — Environment, comms, risk, monitoring, controls

| Criterion                                   | State   | Evidence                                                                                                                                                              |
| ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC1.x Control environment                   | partial | AGENTS.md encodes the invariants (pnpm only, no `any`, native-first, no AI attribution). Solo operator, no board.                                                     |
| CC2.1 Internal comms of security objectives | met     | AGENTS.md hard rules; this doc; `SECURITY.md`.                                                                                                                        |
| CC2.2 External comms to customers           | gap     | No ToS / privacy policy for the hosted deployment. Self-hosters are their own controllers, but `pile.nyc` signups have nothing to read.                               |
| CC3.x Risk assessment                       | partial | Risks mitigated in code (rls middleware, signature-gated webhooks, fail-closed cap gate); no consolidated written risk register — the gap register below is the seed. |
| CC4.1 Ongoing monitoring                    | partial | Worker observability + request logging middleware; no standing alerting on backup cadence or queue depth yet.                                                         |
| CC5.x Control activities                    | met     | Controls are in code and tests: rls() per-route permission gates, webhook signature verification, atomic usage cap enforcement, idempotent webhook dedup.             |

## CC6 — Logical access

| Criterion                 | State   | Evidence                                                                                                                                                                                                         |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC6.1 Access provisioning | met     | Workspace-scoped API tokens (Better Auth apiKey plugin) verified per-request; human sessions via Better Auth; membership checked in `workspaceAuthMiddleware`.                                                   |
| CC6.2 Access removal      | met     | Token delete + member removal are real verbs; workspace delete purges D1 + R2 + DO storage.                                                                                                                      |
| CC6.3 Access review       | **gap** | **No scheduled review.** Quarterly: enumerate members per org, API tokens, Cloudflare account access, GitHub collaborators, 1Password/Veil vaults; diff against expectation. First review next calendar quarter. |
| CC6.6 Least privilege     | met     | rls() scopes by permission ("read"/"write"/"admin", project roles); workspace tokens are org-scoped; no superuser token exists.                                                                                  |
| CC6.7 Data transmission   | met     | TLS end-to-end via Cloudflare; webhook payloads HMAC-signed; secrets never logged (verified by leak-focused tests).                                                                                              |
| CC6.x Encryption at rest  | met     | Provider tokens AES-256-GCM (`encryptSecret`, KEK from `AGENT_SETTINGS_KEK`/`BETTER_AUTH_SECRET`); Better Auth `encryptOAuthTokens` on; D1/DO/R2 encrypted by Cloudflare at rest.                                |

## CC7 — System operations

| Criterion                     | State   | Evidence                                                                                                                           |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CC7.1 Vulnerability detection | met     | trufflehog CI (verified secrets), secretlint gate, dependabot weekly npm + actions updates, knip.                                  |
| CC7.2 Security monitoring     | partial | Request logging + error responses with codes; no WAF tuning beyond Cloudflare defaults — acceptable now, revisit at public launch. |
| CC7.3 Incident response       | met     | `docs/incident-response.md` — severity ladder, comms template, postmortem format.                                                  |
| CC7.4 Incident recovery       | met     | `scripts/dr-restore.sh` — verified restore drill (39/39 tables, exact counts); `docs/runbook-dr.md`.                               |

## CC8 — Change management

| Criterion                         | State   | Evidence                                                                                                                                                                                                                                      |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC8.1 Changes authorized & tested | partial | CI gates everything (vp check, tests, contract check); solo dev means no mandatory second review — anything touching authz/crypto/billing gets an adversarial self-review pass before deploy. Deploys are `wrangler deploy` from `main` only. |

## CC9 — Vendors & continuity

| Criterion                 | State | Evidence                                                                                           |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| CC9.1 Vendor register     | met   | See below.                                                                                         |
| CC9.2 Business continuity | met   | RPO 24h / RTO 4h documented; D1 export + DO export + R2 manifest; restore drill proven end-to-end. |

## Data classification

| Tier             | Data                                                                                                                                                                                    | Handling                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Secrets**      | `BETTER_AUTH_SECRET`, `AGENT_SETTINGS_KEK`, `DISPATCH_SECRET`, `BILLING_WEBHOOK_SECRET`, `VORTEX_BILLING_API_KEY`, GitHub App private key, provider tokens (encrypted), webhook secrets | env/secret store only; never in D1 plaintext, logs, audit, or API responses |
| **Confidential** | issues, comments, support tickets, customer emails, agent sessions/artifacts, workspace metadata, billing accounts                                                                      | org-scoped; rls() or signature/token gates every route                      |
| **Internal**     | usage_records, webhook_deliveries, audit events, request logs                                                                                                                           | ops-only; no customer PII beyond identifiers                                |

## Privacy notes (P-series)

We collect: member emails/names (Better Auth), org membership, issue +
support content (which may embed customer names/emails in ticket text),
capture recordings, agent session traces. CA employee data = CCPA-covered.

- **No privacy notice yet** for hosted `pile.nyc` members — gap (see
  PILE-177); self-hosters publish their own.
- **Data export** exists: `GET /workspaces/{org}/export` dumps D1
  metadata + full DO state; workspace delete is a real verb.
- Retention: backups rotate on a schedule; DR dumps are local-only and
  gitignored.

## Vendor register

Every vendor that touches customer data or production access.

| Vendor           | Role                                                         | Customer data                                     | Access                                 | Assurance                        |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------- | -------------------------------- |
| Cloudflare       | Workers, D1, Durable Objects, R2, Queues, Email Routing, DNS | everything — compute + storage + email in transit | full prod                              | SOC 2 (cloudflare.com/trust-hub) |
| Vortex Billing   | subscriptions, invoices, usage rating                        | org ids, plan state, usage counts                 | billing API + webhooks                 | internal (Vortex)                |
| GitHub           | source hosting, optional repo integration                    | repo metadata via GitHub App                      | repo-scoped tokens, per-request minted | SOC 2                            |
| GitLab           | optional integration                                         | project-scoped PATs (encrypted at rest)           | webhook + API                          | user-supplied instances vary     |
| Better Auth      | auth framework                                               | identity/session data in our D1                   | none (self-hosted lib)                 | library, not a processor         |
| 1Password / Veil | secret escrow + agent creds                                  | KEK-class secrets                                 | escrow only                            | SOC 2                            |

## Gap register

| #   | Gap                                               | Severity              | Action                                                       |
| --- | ------------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| G1  | No privacy policy / ToS for hosted pile.nyc       | high                  | PILE-177 — minimal plain-English doc before external signups |
| G2  | No scheduled access review                        | medium                | Quarterly checklist — CC6.3 above                            |
| G3  | No standing alert on backup cadence / queue depth | medium                | Monitor cron/queue heartbeats; cheap win                     |
| G4  | SAML/SCIM/audit-log streaming                     | low (enterprise gate) | PILE-185/186/187                                             |
| G5  | Consolidated risk register                        | medium                | Promote this doc's register when it outgrows a table         |

## What an auditor gets asked for, and where it lives

| Ask                      | Answer                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| "Access control policy"  | AGENTS.md hard rules + rls() middleware + CC6 above                         |
| "Incident response plan" | `docs/incident-response.md`                                                 |
| "Backups work"           | `scripts/backup.sh` + `dr-restore.sh` + verified drill (docs/runbook-dr.md) |
| "Vendor SOC reports"     | vendor register above                                                       |
| "Change management"      | git history + CI gates + CC8.1 note                                         |
| "Data deletion"          | `DELETE /workspaces/{id}` purge + export path                               |
| "Secrets handling"       | env-only secrets, AES-256-GCM token encryption, secretlint+trufflehog CI    |
