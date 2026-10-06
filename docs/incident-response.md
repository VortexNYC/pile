# Incident response

`docs/runbook-dr.md` has the verbs. This doc has the judgment: severity,
who tells whom, and what a clean incident looks like.

## Severity ladder

| Sev    | Definition                                                 | Examples                                                                                                                                    | Response                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S1** | Secrets exposed, data lost, or auth/tenant boundary broken | `BETTER_AUTH_SECRET`/KEK leaked; cross-workspace issue or ticket data readable (rls bypass); webhook secret forged; billing state corrupted | Stop the bleed first (revoke tokens, rotate secret, roll back deploy). Comms within **24h** to affected workspaces — what happened, what leaked, what we did, what they must do. Postmortem mandatory. |
| **S2** | Control broken, no confirmed exposure                      | Backup script silently failing; queue backlog growing; email binding dead so users never get replies; DO migration drift                    | Fix inside a day. Comms only if customer-visible. Postmortem if the cause wasn't obvious.                                                                                                              |
| **S3** | Degraded but correct                                       | Elevated 5xx on `pile.nyc`; cron sweep late; R2 upload failed but state intact                                                              | Fix on the normal track. Log it.                                                                                                                                                                       |

When unsure between S1 and S2, treat as S1 for 30 minutes while you
prove which it is. Downgrading later is free; upgrading late is not.

## First hour — the checklist

1. **Contain.** Pick the verb before you investigate:
   - Compromised API token / session → revoke via
     `DELETE /workspaces/{org}/tokens/{id}` (or ban the user via
     Better Auth admin endpoints).
   - Compromised workspace → `DELETE /workspaces/{id}` purge path
     (D1 rows + R2 objects + DO storage) or operator-level org wipe.
   - Secret suspicion (`BETTER_AUTH_SECRET`, `DISPATCH_SECRET`,
     `BILLING_WEBHOOK_SECRET`) → `wrangler secret put` rotate +
     redeploy; sessions/tokens minted under the old secret die.
   - Bad deploy → `wrangler rollback` / redeploy last good version id.
   - D1 bad → the Worker fails closed; fix D1, everything recovers.
   - Billing webhook secret forged → rotate `BILLING_WEBHOOK_SECRET`,
     audit `billing_accounts` rows changed in the window.
2. **Preserve.** Snapshot before you clean: `scripts/backup.sh` for a
   point-in-time D1 + DO + R2 capture, Cloudflare dashboard logs for
   the window, relevant `webhook_deliveries`/`audit` rows.
3. **Decide the sev** from the ladder. S1 means comms drafting starts
   now, not after root cause.
   Whoever declares the sev is the **incident lead** — they own
   containment, comms, and status page updates until they hand off
   explicitly.

## Comms

Customer-visible incidents also go on the public status page
(https://status.pile.nyc — use https://pile.openstatus.dev until the
custom domain's TLS is live) — when and how is in `docs/status-page.md`.

S1 template — send to every affected workspace owner, plain text:

```text
Subject: Pile security incident — <date>

What happened: <one sentence, no jargon>
What was exposed: <exactly which workspaces/resources, or "we have no
  evidence any customer data left the platform">
What we did: <containment verb + when>
What you must do: <rotate these tokens / nothing / re-onboard>
Timeline: <detected X, contained Y>
Postmortem follows within 5 days.
```

Rules: name what leaked or say "no evidence of exposure" — never vague
"might have been affected." If credentials left the platform, the "what
you must do" line is a rotation list per token/key.

## Postmortem (S1 mandatory, S2 if non-obvious)

```markdown
# Postmortem — <date>

## What happened

## Timeline (detected / contained / resolved)

## Root cause

## What worked

## What didn't

## Action items (each: owner, due)
```

Blameless: the question is always "what property of the system allowed
this," never "who fumbled." An incident where fail-closed paths fired
and nothing leaked is a success story — write it down too; that's the
evidence an auditor wants to see.

## Bus factor

If the founder is unavailable, the recovery story is:

1. Production secrets are managed via Veil/1Password — vault access is
   the choke point; a trusted second must hold it.
2. Cloudflare account access + this repo + `docs/runbook-dr.md` are the
   entire operational surface.
3. Restore = `scripts/dr-restore.sh` (D1 per-table fixpoint) + workspace
   exports + R2 manifest. The drill was proven on a real dump — 39/39
   tables, exact counts.

Write the second person down by name next to the escrowed secrets.
Undocumented trust is the same as no recovery path.
