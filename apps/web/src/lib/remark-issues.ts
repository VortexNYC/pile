import type { Link, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

const ISSUE_REF = /\b([A-Z]{2,10}-\d+)\b/g;
const IS_REF = /^[A-Z]{2,10}-\d+$/;

/** Splits text nodes on ISSUE-REF tokens and wraps them as links to the
 * issue page. Links' own children are skipped — `[ISS-1](url)` stays
 * untouched — and code carries no text nodes, so backticked refs stay
 * literal. */
export function remarkIssueLinks(options: { workspaceSlug: string }) {
  const href = (ref: string) => `/app/${options.workspaceSlug}/issues/${ref}`;
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      if (parent.type === "link") return;
      ISSUE_REF.lastIndex = 0;
      if (!ISSUE_REF.test(node.value)) {
        ISSUE_REF.lastIndex = 0;
        return;
      }
      ISSUE_REF.lastIndex = 0;
      const tokens = node.value.split(ISSUE_REF);
      const children = tokens
        .filter((tok) => tok.length > 0)
        .map((tok): Text | Link =>
          IS_REF.test(tok)
            ? {
                type: "link",
                url: href(tok),
                children: [{ type: "text", value: tok }],
              }
            : { type: "text", value: tok }
        );
      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}
