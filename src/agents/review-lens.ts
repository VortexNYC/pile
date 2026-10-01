// PILE-287 — domain-lens review priming. A reviewer told "check correctness"
// on billing code reviews generic correctness; a reviewer told "you are the
// billing lens" recalls double-charges, refund races, and currency rounding.
// Dispatch maps the issue's labels and mentioned paths to lenses and folds a
// per-lens reviewer brief into the prompt; the full path→lens index rides
// along so the lane can re-select from its actual diff.

export interface ReviewLens {
  id: string;
  title: string;
  /** Who the reviewer is when primed with this lens. */
  persona: string;
  /** Matched against repo-relative paths, lowercased. */
  paths: RegExp[];
  /** Matched against label names, lowercased. */
  labels: RegExp[];
  questions: string[];
}

export const REVIEW_LENSES: readonly ReviewLens[] = [
  {
    id: "billing",
    title: "Billing lens",
    persona:
      "a payments engineer who has been paged for double-charges and missing refunds",
    paths: [
      /(^|\/)(billing|payments?|invoic\w*|refunds?|payouts?|charges?|subscriptions?|ledger|checkout|pricing|tax\w*)(\/|\.|-|_|$)/,
      /(stripe|finix|avalara|money|currency)/,
    ],
    labels: [
      /billing|payment|invoice|refund|payout|charge|subscription|ledger|pricing|tax|money/,
    ],
    questions: [
      "Can a retry, double-submit, or replayed webhook charge, refund, or pay out twice? Where is the idempotency key, and is it scoped correctly?",
      "Do concurrent refund/capture/void paths race on the same payment? What serializes them?",
      "Are amounts integer minor units end to end? Any float math, implicit currency, or rounding at a boundary?",
      "Is provider I/O kept outside the DB transaction, and is the result persisted only after the provider returns? What happens on a timeout after the provider succeeded?",
      "Do webhook handlers tolerate out-of-order and duplicate events?",
    ],
  },
  {
    id: "auth",
    title: "Auth lens",
    persona:
      "a security engineer who assumes every request is from the wrong tenant",
    paths: [
      /(^|\/)(auth\w*|sessions?|oauth|sso|scim|permissions?|rbac|acl|identity|api-?keys?|tokens?|credentials?|middleware)(\/|\.|-|_|$)/,
    ],
    labels: [/auth|security|permission|rbac|sso|scim|oauth|token|credential/],
    questions: [
      "Is authorization checked on every new route and RPC, not just authentication? Can a caller reach another workspace's rows by id?",
      "Can tokens, keys, or session ids leak into logs, errors, URLs, prompts, or responses?",
      "Are expiry, revocation, and rotation honored? Are secrets compared in constant time?",
      "Does any new default widen access (a permissive scope, a skipped check on an error path)?",
    ],
  },
  {
    id: "data",
    title: "Data/migrations lens",
    persona:
      "a DBA who has to roll this forward while the old code is still serving",
    paths: [
      /(^|\/)migrations?\//,
      /(^|\/)(schema|drizzle\w*|db)(\/|\.)/,
      /\.sql$/,
    ],
    labels: [/migration|schema|database|\bdb\b|data/],
    questions: [
      "Is the migration safe with old and new code running concurrently during deploy? Is the deploy order stated?",
      "Do new NOT NULL columns have defaults or a backfill? Will large-table changes lock or time out?",
      "Is the migration reversible, or is the rollback plan explicit? Are generated artifacts regenerated, not hand-edited?",
      "Do queries stay tenant-scoped and indexed for the new access pattern?",
    ],
  },
  {
    id: "concurrency",
    title: "Concurrency lens",
    persona:
      "an SRE who knows every queue is at-least-once and every alarm fires twice",
    paths: [
      /(durable-object|alarm|queue|cron|sweep|scheduler|mutex|retry|realtime|websocket)/,
      /(^|\/)locks?(\/|\.)/,
    ],
    labels: [/concurrency|race|queue|cron|realtime|durable|reliability/],
    questions: [
      "What happens if this runs twice, concurrently, or is interrupted halfway? Is every side effect idempotent or deduped?",
      "Are read-modify-write sequences serialized (single DO, transaction, conditional update)?",
      "Are timeouts, retries, and backoff bounded so one stuck dependency cannot stall the whole loop?",
      "Does a partial failure leave state that the next run can recover from?",
    ],
  },
  {
    id: "api",
    title: "API-contract lens",
    persona:
      "an SDK maintainer whose users upgrade the server but not the client",
    paths: [
      /(^|\/)(api|routes?|openapi\w*|mcp|sdk|client)(\/|\.)/,
      /openapi\.json$/,
    ],
    labels: [/\bapi\b|contract|openapi|sdk|mcp|breaking/],
    questions: [
      "Is any response field, status code, enum, or default changed in a way existing clients would break on?",
      "Are request schemas validated, with clear errors for bad input? Is pagination bounded?",
      "Were OpenAPI/MCP/CLI artifacts regenerated from the source of truth?",
    ],
  },
  {
    id: "integrations",
    title: "Integrations lens",
    persona: "an on-call engineer debugging a third-party webhook storm at 3am",
    paths: [
      /(github|gitlab|slack|intercom|notion|plain|linear|webhook|email|channels?)(\/|\.|-|_|$)/,
    ],
    labels: [/integration|webhook|github|gitlab|slack|intercom|email/],
    questions: [
      "Are inbound webhooks signature-verified before any work, and deduped by delivery id?",
      "Does the code survive third-party rate limits, 5xx, and slow responses without hot-looping or dropping events?",
      "Can an echo of our own write re-trigger the handler (sync loops)?",
    ],
  },
  {
    id: "agent-runtime",
    title: "Agent-runtime lens",
    persona:
      "a red-teamer who controls the issue text the agent is about to read",
    paths: [/(^|\/)(agents?|runner|sandbox|prompts?)(\/|\.|-|_|$)/, /\.py$/],
    labels: [/agent|sandbox|runner|prompt|lane/],
    questions: [
      "Can untrusted issue/PR/comment text reach a shell, a path, or a prompt boundary unescaped?",
      "Are credentials handed to the sandbox scoped, short-lived, and redacted from transcripts?",
      "Does a stuck or crashed lane leave a visible trace and a recoverable state?",
    ],
  },
  {
    id: "ui",
    title: "UI lens",
    persona: "a keyboard-only user on a slow connection",
    paths: [/\.(tsx|jsx|css|html)$/, /(^|\/)(widget|web|ui|components?)\//],
    labels: [/\bui\b|ux|frontend|design|a11y|accessibility/],
    questions: [
      "Are loading, empty, and error states handled? Is the component usable by keyboard and screen reader?",
      "Is user-supplied content rendered without HTML injection?",
    ],
  },
];

const MAX_SELECTED_LENSES = 4;

const PATH_MENTION_RE =
  /(?:^|[\s`'"([])((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+|(?:[\w.-]+\/){2,})(?=$|[\s`'"),:;\]])/gi;

/** Repo-relative paths named in free text (issue title, description). */
export function extractPathMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_MENTION_RE)) {
    const path = match[1];
    if (!path || path.includes("://") || path.startsWith("//")) continue;
    found.add(path.replace(/^\.\//, ""));
  }
  return [...found];
}

/** Lenses matching any changed/mentioned path or label, in catalog order. */
export function selectReviewLenses(input: {
  paths?: string[];
  labels?: string[];
}): ReviewLens[] {
  const paths = (input.paths ?? []).map((p) => p.toLowerCase());
  const labels = (input.labels ?? []).map((l) => l.toLowerCase());
  return REVIEW_LENSES.filter(
    (lens) =>
      paths.some((p) => lens.paths.some((re) => re.test(p))) ||
      labels.some((l) => lens.labels.some((re) => re.test(l)))
  ).slice(0, MAX_SELECTED_LENSES);
}

function lensBrief(lens: ReviewLens): string[] {
  return [
    `### ${lens.title}`,
    "",
    `You are the ${lens.title.toLowerCase()}: review the diff as ${lens.persona}. Ignore everything outside this domain.`,
    ...lens.questions.map((q) => `- ${q}`),
  ];
}

/** Prompt section priming per-lens reviewers. Always carries the lens index
 *  so the lane can pick lenses from its real diff; selected lenses are
 *  expanded in full. */
export function reviewLensPrompt(selected: ReviewLens[]): string {
  const selectedIds = new Set(selected.map((l) => l.id));
  const others = REVIEW_LENSES.filter((l) => !selectedIds.has(l.id));
  return [
    "## Review lenses",
    "",
    "Before you finish, review your own diff once per applicable lens — ideally one reviewer subagent per lens, each primed with only that lens's brief. A lens is a domain, not a generic correctness pass: ask what goes wrong *in that domain*. Fix what each lens finds before handing off.",
    ...(selected.length > 0
      ? [
          "",
          "This issue's labels and referenced paths map to these lenses:",
          "",
          ...selected.flatMap((lens) => [...lensBrief(lens), ""]),
        ]
      : [""]),
    `Also apply any of these lenses whose domain your changed paths (\`git diff --name-only\`) turn out to touch: ${others.map((l) => `${l.title} (${l.persona})`).join("; ")}.`,
  ].join("\n");
}
