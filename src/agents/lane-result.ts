import { z } from "zod";

import { VortexError } from "../platform/errors.js";

/** Built-in lane result contract (PILE-289): what automations read off a
 *  finished lane without scraping prose. Draft-07 so any validator agrees. */
export const LANE_RESULT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "LaneResult",
  type: "object",
  required: ["verdict", "summary", "filesChanged"],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail", "partial", "blocked"],
      description:
        "pass = task done; partial = some of it; fail = attempted, did not work; blocked = could not proceed without input",
    },
    summary: {
      type: "string",
      minLength: 1,
      description: "One-paragraph outcome for a human or automation",
    },
    filesChanged: {
      type: "array",
      items: { type: "string" },
      description: "Repo-relative paths touched by the lane",
    },
  },
} as const;

const MAX_RESULT_SCHEMA_BYTES = 16_384;
const MAX_REPORTED_ERRORS = 20;

export type ResultSchemaInput = "lane" | Record<string, unknown>;

export type LaneResultEvaluation =
  | { valid: true; value: unknown }
  | { valid: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compile(schema: unknown) {
  if (!isRecord(schema)) {
    throw new Error("result schema must be a JSON Schema object");
  }
  return z.fromJSONSchema(schema, { defaultTarget: "draft-7" });
}

/** Resolve a dispatch-time `resultSchema` to the serialized JSON Schema that
 *  is stored on the session. Rejects schemas Zod can't compile up front so a
 *  bad schema fails the dispatch, not the lane hours later. */
export function resolveResultSchema(input: ResultSchemaInput): string {
  const schema = input === "lane" ? LANE_RESULT_SCHEMA : input;
  const serialized = JSON.stringify(schema);
  if (new TextEncoder().encode(serialized).length > MAX_RESULT_SCHEMA_BYTES) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `resultSchema exceeds ${MAX_RESULT_SCHEMA_BYTES} bytes`,
    });
  }
  try {
    compile(schema);
  } catch (err) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Invalid resultSchema: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return serialized;
}

/** Prompt section telling the lane how to report. Appended to dispatch
 *  instructions so every provider gets the same contract. */
export function buildResultSchemaInstructions(
  serializedSchema: string
): string {
  return [
    "## Structured result",
    "When you finish, end your final message with exactly one fenced ```json block holding a single JSON value that validates against this JSON Schema (draft-07). Automations parse it programmatically — no prose inside the block.",
    "```json",
    serializedSchema,
    "```",
  ].join("\n");
}

const FENCED_JSON = /```json\s*\n([\s\S]*?)```/g;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function lastFencedJson(text: string): unknown {
  let found: unknown;
  let matched = false;
  for (const match of text.matchAll(FENCED_JSON)) {
    const parsed = parseJson(match[1] ?? "");
    if (parsed.ok) {
      found = parsed.value;
      matched = true;
    }
  }
  return matched ? found : undefined;
}

/** Pull the lane's structured payload out of a raw session `result`.
 *  Accepts: a bare JSON document (agent write-back), the CLI runner envelope
 *  (`output_tail` / `transcript` text), or prose ending in a ```json block.
 *  The last parseable fenced block wins — the schema echo in the prompt
 *  comes earlier than the agent's answer. */
export function extractStructuredResult(result: string): unknown {
  const whole = parseJson(result.trim());
  if (whole.ok) {
    const value = whole.value;
    const isRunnerEnvelope =
      isRecord(value) &&
      (typeof value.output_tail === "string" ||
        typeof value.transcript === "string");
    if (!isRunnerEnvelope) return value;
    for (const key of ["output_tail", "transcript"] as const) {
      const text = value[key];
      if (typeof text !== "string") continue;
      const fenced = lastFencedJson(text);
      if (fenced !== undefined) return fenced;
    }
    return undefined;
  }
  return lastFencedJson(result);
}

export function evaluateLaneResult(
  serializedSchema: string,
  result: string
): LaneResultEvaluation {
  const schema = parseJson(serializedSchema);
  if (!schema.ok) {
    return { valid: false, errors: ["Stored result schema is not JSON"] };
  }
  let validator: z.ZodType;
  try {
    validator = compile(schema.value);
  } catch (err) {
    return {
      valid: false,
      errors: [
        `Result schema failed to compile: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  const candidate = extractStructuredResult(result);
  if (candidate === undefined) {
    return {
      valid: false,
      errors: ["No JSON result found in lane output"],
    };
  }
  const parsed = validator.safeParse(candidate);
  if (parsed.success) return { valid: true, value: candidate };
  return {
    valid: false,
    errors: parsed.error.issues
      .slice(0, MAX_REPORTED_ERRORS)
      .map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`
      ),
  };
}

const LABEL_MAX = 60;

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Deterministic run name for logs and `pile fleet`:
 *  `<agent>/<identifier>-<title-slug>[-<purpose>]`, e.g.
 *  `devin/iss-12-fix-login-redirect`. */
export function sessionLabel(
  issue: { id: string; identifier: string | null; title: string },
  agentId: string,
  purpose?: string | null
): string {
  const head = `${slug(agentId) || "agent"}/${slug(issue.identifier ?? "") || issue.id.slice(0, 8)}`;
  const tail = purpose ? `-${slug(purpose)}` : "";
  const room = LABEL_MAX - head.length - tail.length - 1;
  const titleSlug =
    room > 0 ? slug(issue.title).slice(0, room).replace(/-+$/, "") : "";
  return `${head}${titleSlug ? `-${titleSlug}` : ""}${tail}`;
}
