import { CodeBlock } from "@cloudflare/kumo/components/code";
import { Table } from "@cloudflare/kumo/components/table";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-xl font-semibold text-kumo-text mt-4 mb-2 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold text-kumo-text mt-4 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold text-kumo-text mt-4 mb-1.5 first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="text-sm text-kumo-text mb-3 last:mb-0 leading-6">{children}</p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-kumo-link hover:underline"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-3 flex flex-col gap-1 text-sm text-kumo-text">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-3 flex flex-col gap-1 text-sm text-kumo-text">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-kumo-line pl-4 my-3 text-kumo-subtle">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-kumo-line my-4" />,
  code: ({ children, className, node }) => {
    const match = /language-(\w+)/.exec(className ?? "");
    const isBlock = node?.position?.start.line !== node?.position?.end.line || match;
    const LANGS = new Set(["ts", "tsx", "jsonc", "bash", "css"]);
    const lang = match?.[1];
    if (!isBlock) {
      return (
        <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-[13px] font-mono text-kumo-text">
          {children}
        </code>
      );
    }
    return (
      <CodeBlock
        code={String(children).replace(/\n$/, "")}
        lang={
          lang && LANGS.has(lang) ? (lang as "ts" | "tsx" | "jsonc" | "bash" | "css") : undefined
        }
      />
    );
  },
  pre: ({ children }) => <div className="my-3">{children}</div>,
  table: ({ children }) => (
    <Table aria-label="Table" className="my-3">{children}</Table>
  ),
  thead: ({ children }) => <Table.Header>{children}</Table.Header>,
  tbody: ({ children }) => <Table.Body>{children}</Table.Body>,
  tr: ({ children }) => <Table.Row>{children}</Table.Row>,
  th: ({ children }) => <Table.Head>{children}</Table.Head>,
  td: ({ children }) => <Table.Cell>{children}</Table.Cell>,
};

export function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
