import type { InferSelectModel } from "drizzle-orm";

import type { AgentRunUsage } from "../agents/spend.js";
import type { FilterCondition } from "../workspace/filter.js";
import {
  workspaceAgentSessions,
  workspaceDraftOutputs,
  workspaceExternalEventDeliveries,
  workspaceExternalEventMappings,
  workspaceStageTemplates,
} from "../workspace/schema.js";
import type { Id, Timestamp } from "./index.js";

export const AGENT_SESSION_STATUSES = [
  "created",
  "running",
  // PILE-420 — a live lane that went silent: no activity or heartbeat inside
  // the workspace's stale window. Non-terminal — the lane can still recover
  // to `running`, or the sweep cancels it on the inactivity clock.
  "stale",
  "waiting",
  "completed",
  "failed",
  "canceled",
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export type AgentSession = InferSelectModel<typeof workspaceAgentSessions>;

export interface AgentSessionResult {
  status: AgentSessionStatus;
  result?: string | null;
  url?: string | null;
  providerSessionId?: string | null;
  prUrl?: string | null;
  prState?: string | null;
  branch?: string | null;
  // True when the lane died underneath the task — compute substrate error,
  // runner died without a result, or a sweep stall-cancel — rather than the
  // agent reporting a task outcome. Drives auto-retry + the unhealthy streak.
  infraFailure?: boolean;
  // PILE-425 — cumulative usage snapshot the lane/provider reports with this
  // result; lands on the session's run receipt (agent_run_receipts).
  usage?: AgentRunUsage | null;
}

export type { AgentRunUsage };

export interface GitIdentity {
  id: string;
  organizationId: string;
  repo: string;
  name: string;
  email: string;
  githubUsername: string | null;
  signingKeyRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Sentinel `repo` value for a workspace-default git identity — the fallback
 *  when no repo-bound identity exists. Real GitHub repos can't be named `*`,
 *  so the row is unambiguous and needs no schema change. */
export const DEFAULT_GIT_IDENTITY_REPO = "*";

export const ISSUE_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_RESOLUTIONS = [
  "duplicate",
  "not_planned",
  "intended_behavior",
  "not_reproducible",
  "obsolete",
  "resolved",
  // PILE-412 — skipped is how a required stage sub-step ends undone: it
  // counts as done for the stage gate, and the write path requires a
  // non-empty resolutionReason so the "why" is always on the record.
  "skipped",
] as const;
export type IssueResolution = (typeof ISSUE_RESOLUTIONS)[number];

/** Canonical prState domain — every writer (GitHub/GitLab webhooks, lane
 *  results, reconcile) normalizes into these four values. */
export const ISSUE_PR_STATES = ["draft", "open", "merged", "closed"] as const;
export type IssuePrState = (typeof ISSUE_PR_STATES)[number];

export interface IssueInput {
  id?: Id;
  externalRef?: string | null;
  teamId?: string;
  /** Human-friendly alternative to teamId — resolved by team key (e.g. "ISS"). */
  teamKey?: string;
  title: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority;
  resolution?: IssueResolution | null;
  /** PILE-412 — why the issue resolved the way it did. Required when
   *  resolution is "skipped"; recorded on the record and in history. */
  resolutionReason?: string | null;
  parentId?: string | null;
  subIssueSortOrder?: number | null;
  estimate?: number | null;
  isDraft?: boolean;
  /** PILE-428 — review-gated record: agent-produced writes land in
   *  draft_outputs pending human publish instead of going live. */
  sensitive?: boolean;
  templateId?: string;
  snoozedUntil?: string | null;
  assigneeId?: string | null;
  /** Agent executing the issue on the assignee's behalf (PILE-417). */
  delegateId?: string | null;
  /** PILE-411 — stage-template sub-step fields. stepKey marks the issue as
   *  a materialized sub-step (idempotency key with the parent); required is
   *  the stage gate's blocking flag; ownerAgent is the named owning agent. */
  stepKey?: string | null;
  required?: boolean;
  ownerAgent?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  labelIds?: string | null;
  repo?: string | null;
  branch?: string | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

/** Patch surface for updateIssue: every create input plus the PR linkage
 *  fields, which createIssueRecord always seeds to null — the webhook and
 *  lane-completion paths are the usual writers, PATCH exists so a human or
 *  agent can link/unlink a PR without a session. */
export type IssuePatch = Partial<IssueInput> & {
  prUrl?: string | null;
  prState?: IssuePrState | null;
  /** PILE-412 — stage-gate override directive, not a column: when set, an
   *  admin's status change proceeds despite open required sub-steps, and the
   *  reason lands in the audit log and issue history. The API refuses the
   *  flag for non-admin identities; internal callers never set it. */
  stageGateOverride?: { reason: string };
};

export interface IssueCursor {
  createdAt: Timestamp;
  id: Id;
}

// PILE-430 — claim/lease primitive. Result of POST /issues/{id}/claim:
// the lease grant with its fencing epoch. A conflicting claim answers 409
// carrying the current holder instead.
export interface IssueClaim {
  issueId: Id;
  claimedBy: string;
  leaseExpiresAt: string;
  epoch: number;
}

// Per-issue visibility (issue_permissions): undefined viewer = unrestricted
// (workspace admin); otherwise list/search/analytics queries exclude
// restricted issues the viewer isn't granted.
export interface IssueViewer {
  actorId: string;
  teamIds: string[];
  /** Actors without workspace:read only see issues they're granted on. */
  grantedOnly?: boolean;
}

export interface ListIssuesArgs {
  limit?: number;
  cursor?: IssueCursor;
  viewer?: IssueViewer;
  teamId?: string;
  teamIds?: string[];
  status?: IssueStatus;
  priority?: IssuePriority;
  parentId?: string | null;
  hasParent?: boolean;
  isParent?: boolean;
  isDraft?: boolean;
  hideSnoozed?: boolean;
  assigneeId?: string;
  delegateId?: string;
  projectId?: string;
  cycleId?: string;
  labelId?: string;
  search?: string;
  filter?: FilterCondition;
  externalRef?: string;
}

export interface Issue {
  id: Id;
  organizationId: Id;
  externalRef: string | null;
  teamId: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  resolution: IssueResolution | null;
  /** Why the issue resolved the way it did (required on skipped). */
  resolutionReason: string | null;
  parentId: Id | null;
  subIssueSortOrder: number | null;
  estimate: number | null;
  isDraft: boolean;
  /** PILE-428 — agent output on this record drafts for human review
   *  before publishing. */
  sensitive: boolean;
  snoozedUntil: string | null;
  assigneeId: Id | null;
  delegateId: Id | null;
  /** Current claim holder (agent or actor id); null when unclaimed. */
  claimedBy: string | null;
  /** ISO deadline of the active claim lease; null when unclaimed. */
  claimedLeaseExpiresAt: string | null;
  /** Fencing token bumped on every claim-state write (PILE-430). */
  claimEpoch: number;
  /** PILE-411 — the stage sub-step this issue was materialized for; null on
   *  ordinary issues. */
  stepKey: string | null;
  /** Whether this sub-step is required for the parent's stage to complete. */
  required: boolean;
  /** Named pipeline agent owning the sub-step (e.g. "scout"); free-form —
   *  resolved to a registered agent/provider at dispatch time (PILE-413). */
  ownerAgent: string | null;
  projectId: Id | null;
  cycleId: Id | null;
  labelIds: string | null;
  number: number | null;
  identifier: string | null;
  repo: string | null;
  branch: string | null;
  prUrl: string | null;
  prState: string | null;
  prCheckState: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// PILE-411 — stage templates. A template row is one sub-step definition for
// a (entityType, status) stage: when a record of that type enters the status
// the workspace materializes one sub-issue per applicable definition.
export type StageTemplate = InferSelectModel<typeof workspaceStageTemplates>;
export type StageEntityType = StageTemplate["entityType"];

/** Optional JSON rule gating a sub-step definition: {field, equals?}.
 *  Evaluated against the transitioning record's fields plus its custom field
 *  values — `field` names normalize identically on both sides ("hardware
 *  needed", "hardware_needed", and a custom field of either spelling all
 *  resolve to the same key). Without `equals` the step is created only when
 *  the field resolves truthy; with `equals` the stored value must match. */
export interface StepCondition {
  field: string;
  equals?: string | number | boolean;
}

export interface StageTemplateInput {
  entityType?: StageEntityType;
  status: string;
  stepKey: string;
  title: string;
  required?: boolean;
  ownerAgent?: string | null;
  condition?: StepCondition | null;
  position?: number;
  teamId?: string | null;
}

// PILE-422 — external events complete sub-steps. A mapping binds
// (source, eventType) to a stepKey; the matcher resolves the payload to a
// record (entityType + matchPath → externalId/externalRef). `secret` is the
// HMAC-SHA256 credential the source's deliveries are verified against —
// never returned by the API.
export type ExternalEventMapping = InferSelectModel<
  typeof workspaceExternalEventMappings
>;
export type ExternalEventDelivery = InferSelectModel<
  typeof workspaceExternalEventDeliveries
>;
export type ExternalEventEntityType = ExternalEventMapping["entityType"];

/** Delivery outcomes. "replay" is returned for a dedupe hit — the stored
 *  row keeps the original outcome; everything else is written once. */
export const EXTERNAL_EVENT_DELIVERY_STATUSES = [
  "applied",
  "already_done",
  "no_step",
  "no_record",
  "unmapped",
  "invalid_payload",
  "invalid_signature",
] as const;
export type ExternalEventDeliveryStatus =
  (typeof EXTERNAL_EVENT_DELIVERY_STATUSES)[number];

export interface ExternalEventMappingInput {
  source: string;
  eventType: string;
  entityType: ExternalEventEntityType;
  /** Dotted path into the payload resolving to the record's external id —
   *  e.g. "data.merchant_id". Array indexes are numeric segments. */
  matchPath: string;
  stepKey: string;
  secret: string;
  enabled?: boolean;
  createdBy?: string | null;
}

export type ExternalEventMappingPatch = Partial<
  Omit<ExternalEventMappingInput, "createdBy">
>;

export interface ExternalEventIngestInput {
  source: string;
  /** Candidate signature header values collected by the route. */
  signatures: string[];
  /** Provider event id header when present (payload `id` is the fallback). */
  eventId?: string | null;
  /** Raw request body — signature input, evidence, and JSON source. */
  body: string;
}

export interface ExternalEventIngestResult {
  status: ExternalEventDeliveryStatus | "replay" | "unknown_source";
  deliveryId?: string;
  /** For replays: the status the original delivery recorded. */
  outcome?: string;
  completedIssueIds?: string[];
}

export interface Comment {
  id: Id;
  organizationId: Id;
  entityType: string | null;
  entityId: Id | null;
  authorId: Id | null;
  body: string;
  internal: boolean;
  externalId: string | null;
  externalSource: string | null;
  externalAuthor: string | null;
  resolvedAt: Timestamp | null;
  resolvedById: Id | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// PILE-428 — draft-then-publish for agent output on sensitive records:
// the write an agent attempted is stored as a pending draft_output row; a
// human publishes (replays the payload) or discards (row retained).
export const DRAFT_OUTPUT_KINDS = [
  "comment",
  "field_change",
  "message",
  // PILE-404 — merchant-facing artifact drafts (proposal, comparison
  // piece, email): markdown + rendered payload gated on human approval.
  "artifact",
] as const;
export type DraftOutputKind = (typeof DRAFT_OUTPUT_KINDS)[number];

export const DRAFT_OUTPUT_STATUSES = [
  "pending",
  "published",
  "discarded",
] as const;
export type DraftOutputStatus = (typeof DRAFT_OUTPUT_STATUSES)[number];

export type DraftOutput = InferSelectModel<typeof workspaceDraftOutputs>;

/** Payload for kind="comment" — mirrors createComment's input. */
export interface DraftCommentPayload {
  body: string;
  authorId?: string | null;
  mentions?: string[];
  internal?: boolean;
  externalId?: string | null;
  externalSource?: string | null;
  externalAuthor?: string | null;
  /** API-authored drafts: on publish the comment also syncs to the
   *  issue's GitHub/GitLab mapping, matching the original POST. */
  syncToRepo?: boolean;
}

/** Payload for kind="field_change" — the PATCH the agent attempted,
 *  replayed through updateIssue on publish. */
export interface DraftFieldChangePayload {
  fields: IssuePatch;
}

export type RealtimeEvent =
  | {
      type: "connected";
      organizationId: string;
    }
  | {
      type: "issue.created";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "issue.updated";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "pr.updated";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "issue.deleted";
      organizationId: string;
      issueId: Id;
    }
  | {
      type: "comment.created";
      organizationId: string;
      issue: Issue;
      comment: Comment;
    }
  | {
      type: "comment.updated";
      organizationId: string;
      issue: Issue;
      comment: Comment;
    }
  | {
      type: "comment.deleted";
      organizationId: string;
      issueId: Id;
      commentId: Id;
    }
  | {
      type: "document.updated";
      organizationId: string;
      documentId: Id;
    }
  | {
      type: "document.deleted";
      organizationId: string;
      documentId: Id;
    }
  | {
      type: "draft.created";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "draft.updated";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "draft.deleted";
      organizationId: string;
      issueId: Id;
    }
  | {
      type: "agent_session.created";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.updated";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.completed";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.failed";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.canceled";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "support_ticket.created";
      organizationId: string;
      ticketId: Id;
    }
  | {
      type: "support_ticket.updated";
      organizationId: string;
      ticketId: Id;
    }
  | {
      type: "support_ticket.message_created";
      organizationId: string;
      ticketId: Id;
      messageId: Id;
    }
  | {
      type: "support_ticket.note_created";
      organizationId: string;
      ticketId: Id;
      noteId: Id;
    }
  | {
      type: "audit.entry";
      organizationId: string;
      entry: {
        id: string;
        actorId: string | null;
        actorType: string | null;
        action: string;
        entityType: string;
        entityId: string;
        changes: Record<string, { from: unknown; to: unknown }> | null;
        ip: string | null;
        country: string | null;
        userAgent: string | null;
        createdAt: string;
      };
    };
