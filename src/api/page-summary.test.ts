import { describe, expect, it } from "vitest";

import {
  cleanPageText,
  decodeEntities,
  extractPageTitle,
  fetchReadablePage,
  htmlToReadableText,
  summarizeText,
} from "./page-summary.js";

const PAGE = `<!doctype html>
<html>
  <head><title>Hello &amp; welcome</title><style>p { color: red }</style></head>
  <body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article>
      <h1>Launch notes</h1>
      <p>The clipper now captures screenshots.&nbsp;It also summarizes pages.</p>
      <script>console.log("noise")</script>
      <p>Full text is optional.</p>
    </article>
    <footer>Copyright</footer>
  </body>
</html>`;

const htmlFetch: typeof fetch = async () =>
  new Response(PAGE, { headers: { "content-type": "text/html" } });
const jsonFetch: typeof fetch = async () =>
  new Response("{}", { headers: { "content-type": "application/json" } });
const failedFetch: typeof fetch = async () => new Response("", { status: 500 });
const throwingFetch: typeof fetch = async () => {
  throw new Error("network");
};

describe("page summary", () => {
  it("decodes entities", () => {
    expect(decodeEntities("a &amp; b &#39;c&#x27; &nbsp;d &unknown;")).toBe(
      "a & b 'c'  d &unknown;"
    );
  });

  it("extracts the title", () => {
    expect(extractPageTitle(PAGE)).toBe("Hello & welcome");
    expect(extractPageTitle("<html><body>none</body></html>")).toBeNull();
  });

  it("prefers article content and strips noise", () => {
    const text = htmlToReadableText(PAGE);
    expect(text).toContain("Launch notes");
    expect(text).toContain("The clipper now captures screenshots.");
    expect(text).toContain("Full text is optional.");
    expect(text).not.toContain("Home");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("Copyright");
    expect(text).not.toContain("color: red");
  });

  it("falls back to the body when there is no article", () => {
    const text = htmlToReadableText(
      "<html><body><div>Only <b>body</b> here</div></body></html>"
    );
    expect(text).toBe("Only body here");
  });

  it("collapses whitespace and caps full text", () => {
    expect(cleanPageText("  a \t b\n\n\n\n c  ")).toBe("a b\n\nc");
    const long = cleanPageText("x".repeat(50), 10);
    expect(long).toBe(`${"x".repeat(10)}\u2026`);
  });

  it("summarizes using leading sentences", () => {
    const text =
      "First sentence here. Second sentence follows! Third one is longer than the rest? Fourth.";
    expect(summarizeText(text, 50)).toBe(
      "First sentence here. Second sentence follows!"
    );
    expect(summarizeText("short", 50)).toBe("short");
    expect(summarizeText("", 50)).toBe("");
  });

  it("truncates a single long sentence at a word boundary", () => {
    const text = "word ".repeat(40).trim();
    const summary = summarizeText(text, 30);
    expect(summary.endsWith("\u2026")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(31);
    expect(summary).not.toContain("wor\u2026");
  });

  it("fetches and extracts a readable page", async () => {
    const page = await fetchReadablePage("https://example.com/x", htmlFetch);
    expect(page?.title).toBe("Hello & welcome");
    expect(page?.text).toContain("Launch notes");
  });

  it("ignores non-html, failed, and non-http responses", async () => {
    expect(
      await fetchReadablePage("https://example.com/x", jsonFetch)
    ).toBeNull();
    expect(
      await fetchReadablePage("https://example.com/x", failedFetch)
    ).toBeNull();
    expect(
      await fetchReadablePage("https://example.com/x", throwingFetch)
    ).toBeNull();
    expect(await fetchReadablePage("ftp://example.com/x")).toBeNull();
    expect(await fetchReadablePage("not a url")).toBeNull();
  });
});
