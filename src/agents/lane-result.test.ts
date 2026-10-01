import { describe, expect, it } from "vitest";

import { VortexError } from "../platform/errors.js";
import {
  LANE_RESULT_SCHEMA,
  buildResultSchemaInstructions,
  evaluateLaneResult,
  extractStructuredResult,
  resolveResultSchema,
  sessionLabel,
} from "./lane-result.js";

const laneSchema = JSON.stringify(LANE_RESULT_SCHEMA);
const good = { verdict: "pass", summary: "Done", filesChanged: ["a.ts"] };

describe("resolveResultSchema", () => {
  it("expands the built-in lane shape", () => {
    expect(JSON.parse(resolveResultSchema("lane"))).toEqual(LANE_RESULT_SCHEMA);
  });

  it("accepts a caller draft-07 schema", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    };
    expect(JSON.parse(resolveResultSchema(schema))).toEqual(schema);
  });

  it("rejects schemas that do not compile", () => {
    expect(() => resolveResultSchema({ type: "bogus" })).toThrow(VortexError);
    expect(() =>
      resolveResultSchema({ $ref: "#/definitions/missing" })
    ).toThrow(/Invalid resultSchema/);
  });

  it("rejects oversized schemas", () => {
    expect(() =>
      resolveResultSchema({ description: "x".repeat(20_000) })
    ).toThrow(/exceeds/);
  });
});

describe("extractStructuredResult", () => {
  it("reads a bare JSON write-back", () => {
    expect(extractStructuredResult(JSON.stringify(good))).toEqual(good);
  });

  it("takes the last fenced json block from prose", () => {
    const text = [
      "Schema was:",
      "```json",
      '{"verdict":"nope"}',
      "```",
      "All done.",
      "```json",
      JSON.stringify(good),
      "```",
    ].join("\n");
    expect(extractStructuredResult(text)).toEqual(good);
  });

  it("looks inside the CLI runner envelope", () => {
    const envelope = JSON.stringify({
      output_tail: `finished\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n`,
      transcript: null,
      digest: { filesChanged: 1 },
    });
    expect(extractStructuredResult(envelope)).toEqual(good);
  });

  it("returns undefined when nothing parses", () => {
    expect(extractStructuredResult("just prose")).toBeUndefined();
    expect(
      extractStructuredResult(JSON.stringify({ output_tail: "no block" }))
    ).toBeUndefined();
  });
});

describe("evaluateLaneResult", () => {
  it("passes a conforming result", () => {
    expect(evaluateLaneResult(laneSchema, JSON.stringify(good))).toEqual({
      valid: true,
      value: good,
    });
  });

  it("reports path-qualified errors", () => {
    const evaluation = evaluateLaneResult(
      laneSchema,
      JSON.stringify({ verdict: "maybe", summary: "", filesChanged: [1] })
    );
    expect(evaluation.valid).toBe(false);
    if (evaluation.valid) return;
    expect(evaluation.errors.some((e) => e.startsWith("verdict:"))).toBe(true);
    expect(evaluation.errors.some((e) => e.startsWith("summary:"))).toBe(true);
    expect(evaluation.errors.some((e) => e.startsWith("filesChanged.0:"))).toBe(
      true
    );
  });

  it("reports a missing result block", () => {
    expect(evaluateLaneResult(laneSchema, "no json here")).toEqual({
      valid: false,
      errors: ["No JSON result found in lane output"],
    });
  });
});

describe("buildResultSchemaInstructions", () => {
  it("embeds the schema in a fenced block", () => {
    const text = buildResultSchemaInstructions(laneSchema);
    expect(text).toContain("## Structured result");
    expect(text).toContain(`\`\`\`json\n${laneSchema}\n\`\`\``);
  });
});

describe("sessionLabel", () => {
  it("names runs agent/identifier-title", () => {
    expect(
      sessionLabel(
        { id: "uuid-1", identifier: "ISS-12", title: "Fix login redirect!" },
        "devin"
      )
    ).toBe("devin/iss-12-fix-login-redirect");
  });

  it("suffixes purpose and caps length", () => {
    const label = sessionLabel(
      { id: "uuid-1", identifier: "ISS-12", title: "word ".repeat(40) },
      "cursor-cli",
      "preflight"
    );
    expect(label.startsWith("cursor-cli/iss-12-word-")).toBe(true);
    expect(label.endsWith("-preflight")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).not.toContain("--");
  });

  it("falls back to the issue id without an identifier", () => {
    expect(
      sessionLabel(
        { id: "abcdef12-3456", identifier: null, title: "" },
        "codex"
      )
    ).toBe("codex/abcdef12");
  });
});
