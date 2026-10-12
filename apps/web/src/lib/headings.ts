/** Extract markdown headings for a table of contents. Slugs match
 * rehype-slug/github-slugger: lowercase, whitespace → hyphen,
 * strip everything except word chars, hyphens, and underscores. */
export interface DocHeading {
  depth: number;
  text: string;
  slug: string;
}

export function markdownHeadings(content: string): DocHeading[] {
  const headings: DocHeading[] = [];
  let inCode = false;
  for (const line of content.split("\n")) {
    if (line.trim().startsWith("```")) inCode = !inCode;
    if (inCode) continue;
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const hashes = match[1] ?? "#";
    const text = (match[2] ?? "").replace(/[*_`[\]]/g, "").trim();
    const slug = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    headings.push({ depth: hashes.length, text, slug });
  }
  return headings;
}
