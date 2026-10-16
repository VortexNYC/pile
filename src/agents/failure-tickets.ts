import { and, eq, like, sql } from "drizzle-orm";

import { createD1, type D1Client } from "../global/db.js";
import { scrubCaptureText } from "../global/redact.js";
import { supportTickets } from "../global/schema.js";
import { processIncomingMessage } from "../global/support-channels.js";
import {
  findSupportTicketByExternalId,
  updateTicket,
} from "../global/support-tickets.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession } from "../types/workspace.js";
import type { AgentProviderSession } from "./provider.js";

// PILE-410 — provider-error auto-ingest (PILE-390) used to key each ticket on
// the session id, so every failed lane filed a fresh ticket. One devin-cli
// streak opened ~96 identical tickets before anyone noticed. Auto-created
// failure tickets now dedupe on (provider, normalized error signature,
// window): a repeat failure in the window lands as a new message on the
// existing ticket — reopening it if a human already closed it — instead of a
// new ticket. Distinct signatures past the cap roll up into a single summary
// ticket so a broken provider can't flood the inbox with novel errors either.
export const AGENT_FAILURE_TICKET_WINDOW_MS = 6 * 60 * 60 * 1000;
export const AGENT_FAILURE_TICKET_CAP = 5;

/** Provider id safe for embedding in an externalId that is also used as a
 *  LIKE prefix — anything outside [a-z0-9-] would widen the pattern. */
export function failureProviderToken(provider: string): string {
  const token = provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || "unknown";
}

/** Collapse volatile tokens (uuids, hex ids, numbers, whitespace) so two
 *  reports of the same failure hash to the same signature. Scrub first —
 *  secrets must not leak into the key or the ticket body. */
export function normalizeFailureSignature(
  result: string | null | undefined
): string {
  return scrubCaptureText(result ?? "")
    .toLowerCase()
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "#"
    )
    .replace(/\b[0-9a-f]{12,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export async function failureSignatureHash(signature: string): Promise<string> {
  if (signature.length === 0) return "no-detail";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(signature)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, 12);
}

export function agentFailureWindowBucket(nowMs: number): number {
  return Math.floor(nowMs / AGENT_FAILURE_TICKET_WINDOW_MS);
}

/** externalId prefix for one provider's signature tickets in one window —
 *  `${prefix}:${signatureHash}` per ticket; the rollup uses a different
 *  prefix (`agent-failure-rollup:`) so it never counts toward the cap. */
export function agentFailureKeyPrefix(provider: string, nowMs: number): string {
  return `agent-failure:${failureProviderToken(provider)}:w${agentFailureWindowBucket(nowMs)}`;
}

export function agentFailureRollupKey(provider: string, nowMs: number): string {
  return `agent-failure-rollup:${failureProviderToken(provider)}:w${agentFailureWindowBucket(nowMs)}`;
}

/** First scrubbed line of the provider result — what goes in the ticket
 *  title so a triager can act without opening the body. */
export function failureSummary(result: string | null | undefined): string {
  const firstLine = scrubCaptureText(result ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "provider reported failure with no details").slice(
    0,
    100
  );
}

async function countWindowFailureTickets(
  db: D1Client,
  organizationId: string,
  keyPrefix: string
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.organizationId, organizationId),
        eq(supportTickets.externalSource, "api"),
        like(supportTickets.externalId, `${keyPrefix}:%`)
      )
    );
  return rows[0]?.count ?? 0;
}

// Provider-reported task failures land in the workspace support inbox as a
// ticket deduped on (provider, error signature, window) — scrubbed of
// credentials and deliberately NOT auto-escalated to an issue.
export async function ingestFailedAgentSession(
  env: WorkerEnv,
  organizationId: string,
  session: AgentSession,
  polled: AgentProviderSession,
  nowMs = Date.now()
): Promise<void> {
  try {
    const db = createD1(env.D1);
    const keyPrefix = agentFailureKeyPrefix(session.provider, nowMs);
    const signature = normalizeFailureSignature(polled.result);
    const signatureKey = `${keyPrefix}:${await failureSignatureHash(signature)}`;
    const summary = failureSummary(polled.result);

    // A repeat of a signature that already has a ticket just adds a message
    // there — the cap only gates NEW tickets this window.
    let externalTicketId = signatureKey;
    let rolledUp = false;
    const existing = await findSupportTicketByExternalId(
      db,
      organizationId,
      signatureKey,
      "api"
    );
    if (
      !existing &&
      (await countWindowFailureTickets(db, organizationId, keyPrefix)) >=
        AGENT_FAILURE_TICKET_CAP
    ) {
      externalTicketId = agentFailureRollupKey(session.provider, nowMs);
      rolledUp = true;
    }

    const detail = scrubCaptureText(
      [
        `Session: ${session.id}`,
        `Agent: ${session.agentId}`,
        `Provider: ${session.provider}`,
        polled.providerSessionId
          ? `Provider session: ${polled.providerSessionId}`
          : null,
        session.issueId ? `Issue: ${session.issueId}` : null,
        polled.url ? `Provider URL: ${polled.url}` : null,
        polled.infraFailure ? `Infra failure: yes` : null,
        rolledUp
          ? `Rolled up: ${AGENT_FAILURE_TICKET_CAP}+ distinct failure signatures for ${session.provider} this window.`
          : null,
        `Signature: ${signature || "no-detail"}`,
        "",
        polled.result ?? "Provider reported failure with no details.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    );

    const ticket = await processIncomingMessage(db, organizationId, {
      channel: "api",
      externalSource: "api",
      fromEmail: "agent-sessions@pile.internal",
      fromName: "Pile Agents",
      subject: rolledUp
        ? `Agent session failures: ${session.provider} — ${AGENT_FAILURE_TICKET_CAP}+ distinct errors this window`
        : `Agent session failed: ${session.provider} — ${summary}`,
      text: detail,
      externalTicketId,
      // Per-session message id: each failed lane appends exactly one
      // recurrence message to the deduped ticket.
      externalMessageId: `agent-session-${session.id}-failed`,
      subType: "agent-failure",
    });

    // A rollup means the provider is failing in many distinct ways — surface
    // it above the routine medium-priority noise.
    if (rolledUp && ticket.priority !== "high") {
      await updateTicket(
        db,
        organizationId,
        ticket.id,
        {
          priority: "high",
          actorType: "automation",
          actorId: "pile-sweep",
        },
        env
      );
    }
  } catch (err) {
    console.error("failed-session ingest failed", {
      session: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
