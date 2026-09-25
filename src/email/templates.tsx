import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import type { ReactNode } from "react";

/**
 * Outbound transactional templates (React Email). Keep these deliberately
 * plain — support mail should look like mail, not marketing.
 */

function Shell({
  preview,
  children,
}: {
  preview: string;
  children: ReactNode;
}) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#ffffff",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <Container
          style={{ margin: "0 auto", padding: "24px 16px", maxWidth: "560px" }}
        >
          {children}
        </Container>
      </Body>
    </Html>
  );
}

export function TicketReplyEmail({ body }: { body: string }) {
  return (
    <Shell preview={body.slice(0, 120)}>
      <Section>
        <Text style={{ fontSize: "14px", lineHeight: "1.6", color: "#1a1a1e" }}>
          {body}
        </Text>
      </Section>
      <Section>
        <Text style={{ fontSize: "12px", color: "#8a8a92" }}>
          Reply to this email to continue the conversation.
        </Text>
      </Section>
    </Shell>
  );
}

export function ChangelogShippedEmail({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <Shell preview={title}>
      <Section>
        <Text
          style={{
            fontSize: "16px",
            fontWeight: 600,
            color: "#1a1a1e",
            margin: "0 0 8px",
          }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: "14px", lineHeight: "1.6", color: "#1a1a1e" }}>
          {body}
        </Text>
      </Section>
      <Section>
        <Text style={{ fontSize: "12px", color: "#8a8a92" }}>
          You asked for this — you&apos;re getting this because you voted on it.
        </Text>
      </Section>
    </Shell>
  );
}

export async function renderTicketReply(body: string): Promise<string> {
  return render(<TicketReplyEmail body={body} />);
}

export async function renderChangelogShipped(
  title: string,
  body: string
): Promise<string> {
  return render(<ChangelogShippedEmail title={title} body={body} />);
}
