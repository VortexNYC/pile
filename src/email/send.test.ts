import { describe, expect, it, vi } from "vitest";

import { buildMime, sendEmail } from "./send.js";
import { renderTicketReply } from "./templates.js";

describe("outbound email", () => {
  it("builds a multipart MIME message with threading headers", () => {
    const raw = buildMime({
      from: "support@acme.example",
      to: "customer@example.com",
      subject: "Re: checkout broken",
      text: "We found the bug",
      html: "<p>We found the bug</p>",
      inReplyTo: "abc123@mail.customer.com",
    });
    expect(raw).toContain("In-Reply-To: <abc123@mail.customer.com>");
    expect(raw).toContain("References: <abc123@mail.customer.com>");
    // mimetext RFC 2047-encodes the subject — assert the header exists.
    expect(raw).toMatch(/Subject: /);
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
    expect(raw).toContain("Message-ID:");
  });

  it("omits threading headers without inReplyTo", () => {
    const raw = buildMime({
      from: "support@acme.example",
      to: "customer@example.com",
      subject: "Hello",
      text: "hi",
    });
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("References");
  });

  it("renders the reply template as email HTML", async () => {
    const html = await renderTicketReply("Fixed in the latest deploy");
    expect(html).toContain("Fixed in the latest deploy");
    expect(html).toContain("<html");
  });

  // PILE-330 — deferred callers pass the binding snapshot taken when the
  // notification was decided, so a reassigned env.EMAIL can't redirect the
  // send and a missing env binding can't silently skip it.
  it("sends through the binding override, not env.EMAIL", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    await sendEmail(
      { EMAIL: undefined },
      { from: "a@x.example", to: "b@y.example", subject: "s", text: "t" },
      { send }
    );
    expect(send).toHaveBeenCalledOnce();
  });
});
