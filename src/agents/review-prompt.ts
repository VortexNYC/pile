export const DOMAIN_REVIEW_PROMPT = `## Domain-lens review

When reviewing code changes, including your own before handoff, choose review lenses from the actual changed paths and any available issue/PR label names. Resolve labels to names when available; opaque label IDs are not domain hints. Paths and labels are additive hints: inspect the diff and callers to confirm relevance, and include domains affected across file boundaries. Skip this review for docs-only changes and keep the effort proportionate to the diff.

Use this mapping as a starting point (path fragments and label names are case-insensitive):

| Changed paths or labels | Domain lens | Specialist questions |
| --- | --- | --- |
| billing, payment, invoice, refund, subscription, pricing | The billing lens | Can retries double-charge? Can refunds race charges or exceed the paid amount? Are currencies, minor units, rounding, and subscription transitions consistent? |
| auth, permission, membership, token, credential, security | The identity and access lens | Can one workspace read or mutate another's data? Do revoked tokens or removed members retain access? Are secrets exposed in logs or responses? |
| db, schema, migration, durable-object, storage, data | The persistence lens | Can concurrent writes lose updates or break invariants? Can migrations preserve existing rows? Do transactions, retries, and partial failures leave recoverable state? |
| webhook, integration, github, gitlab, slack, intercom, sync, import | The integrations lens | What happens on duplicate, delayed, or out-of-order events? Are signatures, rate limits, pagination, and partial failures handled? Can retries repeat external side effects? |
| agents, runner, dispatch, session, sandbox, compute, prompt | The agent execution lens | Can duplicate dispatches start competing runs? Do cancellation, timeout, resume, and late results preserve session state? Can credentials or repository scope escape the intended lane? |
| ui, frontend, component, widget, capture, accessibility | The user interaction lens | Can stale responses or repeated actions corrupt visible state? Are loading, empty, error, keyboard, and permission states usable? Does optimistic state reconcile with server failures? |

Choose only relevant lenses; combine overlapping hints into one pass per domain. If none match, name the changed component's actual domain and its invariants rather than using a generic correctness lens.

If reviewer subagents are available and the diff warrants them, give each selected lens to a separate reviewer. Otherwise perform the same focused passes yourself. Prime each reviewer with this template, filling in the domain, scope, and questions:

"You are reviewing through the <domain> lens. Review <changed paths and affected callers> against <base/head or supplied diff>. Focus on these domain failure modes: <specialist questions above, plus repository-specific invariants>. Read the relevant implementation and tests. Report only actionable defects introduced by this change, with severity, file/line, a concrete trigger, and impact. Say no findings when none are supported by evidence. Do not edit code."

Provide each reviewer the diff/base reference and relevant label names. Consolidate duplicate findings, verify their triggers, and address confirmed defects before handoff. Do not invent findings to fill a lens.`;
