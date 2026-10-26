import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeedbackAnnotator } from "./feedback-annotate";

describe("FeedbackAnnotator", () => {
  it("is a mountable component", () => {
    expect(typeof FeedbackAnnotator).toBe("function");
  });

  it("renders the editor chrome over the screenshot", () => {
    const html = renderToStaticMarkup(
      <FeedbackAnnotator
        src="data:image/png;base64,AAAA"
        onApply={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain("Highlight");
    expect(html).toContain("Pen");
    expect(html).toContain('aria-label="Annotation canvas"');
    expect(html).toContain("Apply annotation");
  });
});
