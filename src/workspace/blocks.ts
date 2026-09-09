// BlockNote JSON → markdown / plaintext. Structural, not exhaustive —
// covers the block types agents actually produce.
interface Block {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((node) => {
      if (typeof node === "string") return node;
      if (typeof node === "object" && node !== null) {
        const rec = node as Record<string, unknown>;
        if (typeof rec.text === "string") return rec.text as string;
        if (Array.isArray(rec.content)) return inlineText(rec.content);
      }
      return "";
    })
    .join("");
}

export function blocksToMarkdown(raw: string): string {
  let blocks: Block[];
  try {
    blocks = JSON.parse(raw) as Block[];
  } catch {
    return "";
  }
  const lines: string[] = [];
  const emit = (block: Block, depth: number) => {
    const indent = "  ".repeat(depth);
    const text = inlineText(block.content);
    const type = block.type ?? "paragraph";
    if (type === "heading") {
      const level = (block.props?.level as number | undefined) ?? 1;
      lines.push(`${"#".repeat(Math.min(level, 6))} ${text}`);
    } else if (type === "bulletListItem") {
      lines.push(`${indent}- ${text}`);
    } else if (type === "numberedListItem") {
      lines.push(`${indent}1. ${text}`);
    } else if (type === "checkListItem") {
      const checked = block.props?.checked === true ? "x" : " ";
      lines.push(`${indent}- [${checked}] ${text}`);
    } else if (type === "codeBlock") {
      const lang = (block.props?.language as string | undefined) ?? "";
      lines.push(`${indent}\`\`\`${lang}`, `${indent}${text}`, `${indent}\`\`\``);
    } else if (type === "quote") {
      lines.push(`${indent}> ${text}`);
    } else if (text) {
      lines.push(`${indent}${text}`);
    }
    if (Array.isArray(block.children)) {
      for (const child of block.children as Block[]) emit(child, depth + 1);
    }
  };
  for (const block of blocks) emit(block, 0);
  return lines.join("\n");
}
