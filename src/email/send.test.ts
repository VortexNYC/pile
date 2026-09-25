import { describe, expect, it } from "vitest";

import { buildMime } from "./send.js";
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
});
