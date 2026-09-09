import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import type { Email } from "postal-mime";

import { createD1 } from "../global/db.js";
import { emailInboxes } from "../global/schema.js";
import { findUserByEmail } from "../global/users.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { getWorkspaceStub } from "../platform/stub.js";

const MAX_BODY_LENGTH = 100_000;

function normalizeEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

function getFromAddress(email: Email, envelopeFrom: string): string {
  const parsed = email.from;
  if (parsed && "address" in parsed && typeof parsed.address === "string") {
    return normalizeEmail(parsed.address);
  }
  return normalizeEmail(envelopeFrom);
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^(?:re|fw|fwd):\s*/i, "").trim();
}

function findIssueIdentifier(subject: string): string | undefined {
  const match = subject.match(/\b([A-Z][A-Z0-9]*-\d+)\b/);
  return match?.[1];
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_LENGTH) return body;
  return `${body.slice(0, MAX_BODY_LENGTH)}\n\n[truncated]`;
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: WorkerEnv
): Promise<void> {
  const d1 = createD1(env.D1);
  const to = normalizeEmail(message.to);

  const inbox = await d1
    .select()
    .from(emailInboxes)
    .where(eq(emailInboxes.address, to))
    .get();

  if (!inbox || !inbox.enabled) {
    message.setReject("No route");
    return;
  }

  const parsed = await PostalMime.parse(message.raw);
  const fromAddress = getFromAddress(parsed, message.from);
  const subject = parsed.subject ?? "";
  const body = truncateBody(parsed.text?.trim() ?? "");

  const user = await findUserByEmail(d1, fromAddress);
  const actorId = user?.id ?? fromAddress;
  const stub = getWorkspaceStub(env, inbox.organizationId);
  await stub.setOrganizationId(inbox.organizationId);

  const issueIdentifier = findIssueIdentifier(subject);
  if (issueIdentifier) {
    const issue = await stub.getIssueByIdentifier(issueIdentifier);
    if (issue) {
      const comment = await stub.createComment({
        issueId: issue.id,
        body,
        authorId: user?.id ?? null,
        externalAuthor: user ? undefined : fromAddress,
        externalSource: "email",
        externalId: parsed.messageId ?? undefined,
      });
      if (!comment) {
        throw new Error("Failed to create comment");
      }
      await stub.emitCommentCreated(comment, issue, actorId);
      return;
    }
  }

  const title = stripReplyPrefix(subject) || `Email from ${fromAddress}`;
  const description = user ? body : `From: ${fromAddress}\n\n${body}`;

  await stub.createIssue(
    {
      title,
      description,
      teamId: inbox.teamId ?? undefined,
      projectId: inbox.projectId ?? undefined,
      status: "triage",
      priority: "medium",
    },
    actorId
  );
}
