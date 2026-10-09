import { Table } from "@cloudflare/kumo/components/table";
import { Streamdown } from "streamdown";

import "streamdown/styles.css";

const components = {
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-kumo-link hover:underline"
    >
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <Table aria-label="Table" className="my-3">
      {children}
    </Table>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <Table.Header>{children}</Table.Header>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <Table.Body>{children}</Table.Body>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <Table.Row>{children}</Table.Row>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <Table.Head>{children}</Table.Head>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <Table.Cell>{children}</Table.Cell>
  ),
};

export function Markdown({ content }: { content: string }) {
  return <Streamdown components={components}>{content}</Streamdown>;
}
