import { z } from "zod";

const adfMarkSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const adfTextNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  marks: z.array(adfMarkSchema).optional(),
});

const adfNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(adfNodeSchema).optional(),
    text: z.string().optional(),
    marks: z.array(adfMarkSchema).optional(),
  })
);

function isAdfNode(value: unknown): value is {
  type: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
} {
  const parsed = adfNodeSchema.safeParse(value);
  return parsed.success;
}

function applyMarks(text: string, marks?: unknown[]): string {
  if (!marks) return text;
  let result = text;
  for (const raw of marks) {
    const mark = adfMarkSchema.safeParse(raw);
    if (!mark.success) continue;
    switch (mark.data.type) {
      case "strong":
        result = `**${result}**`;
        break;
      case "em":
        result = `*${result}*`;
        break;
      case "code":
        result = `\`${result}\``;
        break;
      case "strike":
        result = `~~${result}~~`;
        break;
      case "underline":
        result = `<u>${result}</u>`;
        break;
      case "subsup": {
        const attr = z.object({ type: z.string() }).safeParse(mark.data.attrs);
        if (attr.success && attr.data.type === "sub")
          result = `<sub>${result}</sub>`;
        else if (attr.success && attr.data.type === "sup")
          result = `<sup>${result}</sup>`;
        break;
      }
      case "link": {
        const attr = z.object({ href: z.string() }).safeParse(mark.data.attrs);
        if (attr.success) result = `[${result}](${attr.data.href})`;
        break;
      }
      case "textColor":
      case "backgroundColor":
        break;
    }
  }
  return result;
}

function renderInlineContent(content: unknown[]): string {
  return content
    .map((item) => {
      const node = isAdfNode(item) ? item : null;
      if (!node) return "";
      if (node.type === "text") {
        const parsed = adfTextNodeSchema.safeParse(item);
        return parsed.success
          ? applyMarks(parsed.data.text, parsed.data.marks)
          : "";
      }
      if (node.type === "hardBreak") return "\n";
      if (node.type === "emoji") {
        const attrs = z.object({ shortName: z.string() }).safeParse(node.attrs);
        return attrs.success ? `:${attrs.data.shortName}:` : "";
      }
      if (node.type === "mention") {
        const attrs = z
          .object({
            text: z.string().optional(),
            userType: z.string().optional(),
          })
          .safeParse(node.attrs);
        return attrs.success
          ? `@${attrs.data.text ?? attrs.data.userType ?? ""}`
          : "";
      }
      if (node.type === "inlineCard") {
        const attrs = z.object({ url: z.string() }).safeParse(node.attrs);
        return attrs.success ? `<${attrs.data.url}>` : "";
      }
      if (node.type === "date") {
        const attrs = z.object({ timestamp: z.string() }).safeParse(node.attrs);
        if (attrs.success) {
          try {
            return (
              new Date(attrs.data.timestamp).toISOString().split("T")[0] ?? ""
            );
          } catch {
            return attrs.data.timestamp;
          }
        }
      }
      return adfToMarkdown(item);
    })
    .join("");
}

function renderBlock(
  node: { type: string; attrs?: Record<string, unknown>; content?: unknown[] },
  indent: string
): string {
  switch (node.type) {
    case "paragraph":
      return `${indent}${renderInlineContent(node.content ?? [])}\n\n`;
    case "heading": {
      const attrs = z
        .object({ level: z.number().int().min(1).max(6) })
        .safeParse(node.attrs);
      const level = attrs.success ? attrs.data.level : 1;
      return `${indent}${"#".repeat(level)} ${renderInlineContent(node.content ?? [])}\n\n`;
    }
    case "blockquote":
      return (node.content ?? [])
        .map((child) => {
          const block = isAdfNode(child) ? child : null;
          return block
            ? `> ${indent}${renderBlock(block, indent).replace(/\n+$/, "")}\n`
            : "";
        })
        .join("");
    case "codeBlock": {
      const attrs = z
        .object({ language: z.string().optional() })
        .safeParse(node.attrs);
      const language = attrs.success ? (attrs.data.language ?? "") : "";
      const code = node.content ? renderInlineContent(node.content) : "";
      return `${indent}\`\`\`${language}\n${code}\n\`\`\`\n\n`;
    }
    case "bulletList": {
      let result = "";
      for (const raw of node.content ?? []) {
        const item =
          isAdfNode(raw) && (raw as { type: string }).type === "listItem"
            ? raw
            : null;
        if (!item) continue;
        const itemContent = (item.content ?? [])
          .map((child) => adfToMarkdownWithIndent(child, `${indent}  `))
          .join("");
        result += `${indent}- ${itemContent.trimStart()}`;
      }
      return result ? `${result}\n` : "";
    }
    case "orderedList": {
      let result = "";
      let index = 1;
      const attrs = z
        .object({ order: z.number().int().optional() })
        .safeParse(node.attrs);
      if (attrs.success && attrs.data.order) index = attrs.data.order;
      for (const raw of node.content ?? []) {
        const item =
          isAdfNode(raw) && (raw as { type: string }).type === "listItem"
            ? raw
            : null;
        if (!item) continue;
        const itemContent = (item.content ?? [])
          .map((child) => adfToMarkdownWithIndent(child, `${indent}   `))
          .join("");
        result += `${indent}${index}. ${itemContent.trimStart()}`;
        index++;
      }
      return result ? `${result}\n` : "";
    }
    case "taskList": {
      let result = "";
      for (const raw of node.content ?? []) {
        const item =
          isAdfNode(raw) && (raw as { type: string }).type === "taskItem"
            ? raw
            : null;
        if (!item) continue;
        const attrs = z.object({ state: z.string() }).safeParse(item.attrs);
        const checked =
          attrs.success && attrs.data.state === "DONE" ? "x" : " ";
        const itemContent = (item.content ?? [])
          .map((child) => adfToMarkdownWithIndent(child, `${indent}  `))
          .join("");
        result += `${indent}- [${checked}] ${itemContent.trimStart()}`;
      }
      return result ? `${result}\n` : "";
    }
    case "panel": {
      const attrs = z.object({ panelType: z.string() }).safeParse(node.attrs);
      const panelType = attrs.success ? attrs.data.panelType : "info";
      const body = (node.content ?? [])
        .map((child) => adfToMarkdownWithIndent(child, indent))
        .join("");
      return body ? `::: ${panelType}\n${body}:::\n\n` : "";
    }
    case "rule":
      return `${indent}---\n\n`;
    case "table": {
      const rows = (node.content ?? [])
        .filter(
          (raw): raw is { type: string; content?: unknown[] } =>
            isAdfNode(raw) && (raw as { type: string }).type === "tableRow"
        )
        .map((row) =>
          (row.content ?? [])
            .filter(
              (cell): cell is { type: string; content?: unknown[] } =>
                isAdfNode(cell) &&
                ((cell as { type: string }).type === "tableHeader" ||
                  (cell as { type: string }).type === "tableCell")
            )
            .map((cell) =>
              renderInlineContent(
                (cell.content ?? []).flatMap((c) =>
                  isAdfNode(c) && c.type === "paragraph"
                    ? (c.content ?? [])
                    : [c]
                )
              )
            )
            .join(" | ")
        );
      if (rows.length === 0) return "";
      const header = `| ${rows[0]} |`;
      const separator = `| ${rows[0]
        .split(" | ")
        .map(() => "---")
        .join(" | ")} |`;
      const body = rows
        .slice(1)
        .map((row) => `| ${row} |`)
        .join("\n");
      return `${indent}${header}\n${indent}${separator}${body ? `\n${indent}${body}` : ""}\n\n`;
    }
    case "media": {
      const attrs = z
        .object({
          id: z.string(),
          type: z.string(),
          collection: z.string().optional(),
          alt: z.string().optional(),
        })
        .safeParse(node.attrs);
      if (attrs.success) {
        return `${indent}![${attrs.data.alt ?? attrs.data.type}](media:${attrs.data.id})\n\n`;
      }
      return "";
    }
    case "inlineCard":
    case "blockCard": {
      const attrs = z.object({ url: z.string() }).safeParse(node.attrs);
      return attrs.success ? `${indent}<${attrs.data.url}>\n\n` : "";
    }
    case "placeholder": {
      const attrs = z.object({ text: z.string() }).safeParse(node.attrs);
      return attrs.success ? `${indent}<!-- ${attrs.data.text} -->\n\n` : "";
    }
    default:
      return "";
  }
}

function adfToMarkdownWithIndent(value: unknown, indent: string): string {
  if (!isAdfNode(value)) return "";
  const node = value as {
    type: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
  };
  if (node.type === "paragraph") {
    return `${indent}${renderInlineContent(node.content ?? [])}\n`;
  }
  return renderBlock(node, indent);
}

export function adfToMarkdown(value: unknown): string {
  const parsed = adfNodeSchema.safeParse(value);
  if (!parsed.success) return "";
  const doc = parsed.data as { type: string; content?: unknown[] };
  if (doc.type !== "doc" && !doc.content) {
    return adfToMarkdownWithIndent(value, "");
  }
  return (doc.content ?? [])
    .map((child) => adfToMarkdownWithIndent(child, ""))
    .join("");
}
