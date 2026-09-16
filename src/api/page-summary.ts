export const SUMMARY_MAX_CHARS = 400;
export const FULL_TEXT_MAX_CHARS = 20_000;
const FETCH_MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 8_000;

const BLOCK_TAGS =
  "p|div|br|li|ul|ol|h[1-6]|section|article|blockquote|pre|tr|td|th|table|figure|figcaption|dd|dt|dl|hr";
const NOISE_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      if (lower.startsWith("#")) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[lower] ?? match;
    }
  );
}

function stripTag(html: string, tag: string): string {
  return html.replace(
    new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"),
    " "
  );
}

function firstMatch(html: string, tag: string): string | null {
  const match = html.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  );
  return match?.[1] ?? null;
}

export function cleanPageText(
  text: string,
  maxChars = FULL_TEXT_MAX_CHARS
): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars).trimEnd()}\u2026`;
}

export function extractPageTitle(html: string): string | null {
  const raw = firstMatch(html, "title");
  if (!raw) return null;
  const title = cleanPageText(decodeEntities(raw.replace(/<[^>]+>/g, " ")));
  return title.length > 0 ? title : null;
}

export function htmlToReadableText(
  html: string,
  maxChars = FULL_TEXT_MAX_CHARS
): string {
  let scoped = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of NOISE_TAGS) {
    scoped = stripTag(scoped, tag);
  }
  const body =
    firstMatch(scoped, "article") ??
    firstMatch(scoped, "main") ??
    firstMatch(scoped, "body") ??
    scoped;
  const text = body
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ");
  return cleanPageText(decodeEntities(text), maxChars);
}

export function summarizeText(
  text: string,
  maxChars = SUMMARY_MAX_CHARS
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  if (flat.length <= maxChars) return flat;

  const sentences = flat.match(/[^.!?]+[.!?]+(?:["')\]]+)?(?=\s|$)|[^.!?]+$/g);
  let summary = "";
  for (const sentence of sentences ?? []) {
    const candidate = summary
      ? `${summary} ${sentence.trim()}`
      : sentence.trim();
    if (candidate.length > maxChars) break;
    summary = candidate;
  }
  if (summary.length > 0) {
    return summary;
  }
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}\u2026`;
}

export interface FetchedPage {
  title: string | null;
  text: string;
}

export async function fetchReadablePage(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedPage | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "PileClipper/2.0 (+https://pile.nyc)",
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return null;
    }
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder().decode(buffer.slice(0, FETCH_MAX_BYTES));
    return { title: extractPageTitle(html), text: htmlToReadableText(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
