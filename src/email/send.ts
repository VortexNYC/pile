import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

import type { WorkerEnv } from "../platform/middleware.js";

export type OutboundEmail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[];
};

/**
 * Build the raw MIME message. `inReplyTo`/`references` carry RFC threading
 * headers so replies land in the same thread in the recipient's mail client.
 */
export function buildMime(input: OutboundEmail): string {
  const msg = createMimeMessage();
  msg.setSender({ addr: input.from });
  msg.setRecipient(input.to);
  msg.setSubject(input.subject);
  if (input.inReplyTo) {
    msg.setHeader("In-Reply-To", `<${input.inReplyTo}>`);
    msg.setHeader(
      "References",
      (input.references ?? [])
        .concat(input.inReplyTo)
        .map((id) => `<${id}>`)
        .join(" ")
    );
  }
  msg.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) {
    msg.addMessage({ contentType: "text/html", data: input.html });
  }
  return msg.asRaw();
}

/** Send a MIME email through the EMAIL binding. */
export async function sendEmail(
  env: WorkerEnv,
  input: OutboundEmail
): Promise<void> {
  if (!env.EMAIL) {
    throw new Error("EMAIL binding not configured");
  }
  await env.EMAIL.send(
    new EmailMessage(input.from, input.to, buildMime(input))
  );
}
