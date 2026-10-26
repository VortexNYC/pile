// PILE-651 — Canonical field-sales knock outcomes for
// POST /workspaces/{org}/customers/{id}/interactions. One vocabulary shared
// by the API route and the web "Log touch" dialog — keep this module
// dependency-free: apps/web imports it directly.

export const CUSTOMER_TOUCH_OUTCOMES = [
  "talked",
  "sent_info",
  "needs_email",
  "quoted",
  "callback",
  "no_answer",
  "not_interested",
  "spam",
] as const;

export type CustomerTouchOutcome = (typeof CUSTOMER_TOUCH_OUTCOMES)[number];

export function isCustomerTouchOutcome(
  value: unknown
): value is CustomerTouchOutcome {
  return (
    typeof value === "string" &&
    (CUSTOMER_TOUCH_OUTCOMES as readonly string[]).includes(value)
  );
}

export interface TouchOutcomeDefault {
  /** Human label for pickers. */
  label: string;
  /**
   * Ordered status keys to try for auto-advance — the first key matching a
   * workspace `customer_statuses` row (by `key`, else slugged `name`) wins.
   * Empty → the outcome never changes stage. The chain covers both the
   * canonical Vortex vocabulary (prospect→…→lost) and the generic sheet
   * vocabulary (new/contacted/quoted/dead) other workspaces imported.
   */
  statusKeys: readonly string[];
  /** Default next-step text when the caller didn't pass one. */
  nextStepText?: string;
  /** Days from the touch for the default nextStepDueAt. */
  dueInDays?: number;
  /** Terminal outcomes wipe any pending next step unless the caller set one. */
  clearNextStep?: boolean;
  /** Applied to needsHuman / needsHumanReason. */
  needsHuman: boolean;
  needsHumanReason: string | null;
}

export const OUTCOME_DEFAULTS: Record<
  CustomerTouchOutcome,
  TouchOutcomeDefault
> = {
  talked: {
    label: "Talked to someone",
    statusKeys: ["discovery", "engaged", "contacted", "outreach"],
    nextStepText: "Follow up after conversation",
    dueInDays: 2,
    needsHuman: false,
    needsHumanReason: null,
  },
  sent_info: {
    label: "Sent / left info",
    statusKeys: ["outreach", "contacted"],
    nextStepText: "Follow up on info sent",
    dueInDays: 3,
    needsHuman: false,
    needsHumanReason: null,
  },
  needs_email: {
    label: "Need their email",
    statusKeys: ["outreach", "contacted"],
    nextStepText: "Find decision-maker email and send intro",
    dueInDays: 1,
    needsHuman: true,
    needsHumanReason: "Missing decision-maker email",
  },
  quoted: {
    label: "Quoted",
    statusKeys: ["proposal", "quoted"],
    nextStepText: "Follow up on quote",
    dueInDays: 3,
    needsHuman: false,
    needsHumanReason: null,
  },
  callback: {
    label: "Asked to call back",
    statusKeys: [],
    nextStepText: "Call back",
    dueInDays: 2,
    needsHuman: false,
    needsHumanReason: null,
  },
  no_answer: {
    label: "No answer",
    statusKeys: [],
    nextStepText: "Retry visit / call",
    dueInDays: 2,
    needsHuman: false,
    needsHumanReason: null,
  },
  not_interested: {
    label: "Not interested",
    statusKeys: ["lost", "dead"],
    clearNextStep: true,
    needsHuman: false,
    needsHumanReason: null,
  },
  spam: {
    label: "Spam / bad fit",
    statusKeys: ["lost", "dead"],
    clearNextStep: true,
    needsHuman: false,
    needsHumanReason: null,
  },
};

/** The primary (preferred) status key an outcome advances to — undefined
 *  when the outcome never moves the pipeline stage. */
export function outcomeToStatusKey(
  outcome: CustomerTouchOutcome
): string | undefined {
  return OUTCOME_DEFAULTS[outcome].statusKeys[0];
}

/** Every status key an outcome may advance to, in preference order. */
export function outcomeStatusKeys(
  outcome: CustomerTouchOutcome
): readonly string[] {
  return OUTCOME_DEFAULTS[outcome].statusKeys;
}

// Same slug normalization as stageKey in src/workspace/data — duplicated
// here so this module stays dependency-free for the web bundle.
function slugKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolve an outcome's stage advance against the workspace's own statuses:
 *  the first statusKey matching a row's immutable `key` (or its slugged
 *  name) wins. Undefined → leave `statusId` untouched. */
export function resolveOutcomeStatusId(
  outcome: CustomerTouchOutcome,
  statuses: ReadonlyArray<{
    id: string;
    key: string | null;
    name: string;
  }>
): string | undefined {
  for (const key of OUTCOME_DEFAULTS[outcome].statusKeys) {
    const hit = statuses.find((s) => (s.key ?? slugKey(s.name)) === key);
    if (hit) return hit.id;
  }
  return undefined;
}

const DAY_MS = 86_400_000;

/** Default `nextStepDueAt` for an outcome — `dueInDays` from `now` as an
 *  ISO timestamp, or undefined when the outcome carries no default due. */
export function outcomeDefaultDueAt(
  outcome: CustomerTouchOutcome,
  now: Date = new Date()
): string | undefined {
  const days = OUTCOME_DEFAULTS[outcome].dueInDays;
  if (days === undefined) return undefined;
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/** Resolved write for the next-step fields given caller input. Explicit
 *  body values win; `null` clears; absent body values fall back to the
 *  outcome default (or clear, for terminal outcomes). `undefined` in the
 *  result means "leave the column alone". */
export function resolveNextStep(
  outcome: CustomerTouchOutcome,
  input: { nextStepText?: string | null; nextStepDueAt?: string | null },
  now: Date = new Date()
): { nextStepText?: string | null; nextStepDueAt?: string | null } {
  const defaults = OUTCOME_DEFAULTS[outcome];
  const clear = defaults.clearNextStep === true;
  const nextStepText =
    input.nextStepText !== undefined
      ? input.nextStepText
      : clear
        ? null
        : defaults.nextStepText;
  const nextStepDueAt =
    input.nextStepDueAt !== undefined
      ? input.nextStepDueAt
      : clear
        ? null
        : outcomeDefaultDueAt(outcome, now);
  return { nextStepText, nextStepDueAt };
}
