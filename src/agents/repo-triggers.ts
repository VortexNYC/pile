import {
  fetchPileRepoConfig,
  PILE_REPO_TRIGGER_EVENTS,
  type PileRepoConfig,
  type PileRepoTrigger,
  type PileRepoTriggerEvent,
} from "../global/pile-repo-config.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { FLEET_UNHEALTHY_STREAK, fleetInfraStreak } from "./fleet-health.js";
import { dispatchAgent } from "./index.js";

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

const DEFAULT_MENTION_HANDLE = "@pile";

// Internal event names that surface under a different trigger name.
const EVENT_ALIASES = new Map<string, PileRepoTriggerEvent>([
  ["pr.ci_failed", "ci.failed"],
  ["pr.review_changes", "pr.changes_requested"],
]);

/** A lane a repo trigger dispatched. Its own PR events (CI red, a review,
 *  a conflict) must not fire repo triggers again — that's the self-feed
 *  loop (PILE-304); the nudge path fixes the lane in place instead. */
export function isTriggerLane(session: { purpose?: string | null }): boolean {
  return session.purpose?.startsWith("trigger:") === true;
}

/** What an event fired against. `issue` resolves lazily (and once) so
 *  events on unmapped PRs only materialize an issue when something matches. */
export interface AutomationEventTarget {
  /** Repo whose `.pile/config.json` is consulted; read off the issue when
   *  omitted. */
  repo?: string | null;
  issue: () => Promise<Issue | null>;
}

/** Event details trigger filters match on. */
export interface AutomationEventFacts {
  label?: string;
  body?: string;
}

export function automationEventTarget(
  resolve: () => Promise<Issue | null | undefined>,
  repo?: string | null
): AutomationEventTarget {
  let cached: Promise<Issue | null> | undefined;
  return {
    repo,
    issue: () => {
      cached ??= resolve().then(
        (issue) => issue ?? null,
        (err: unknown) => {
          console.error("automation event target unresolved", {
            repo,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      );
      return cached;
    },
  };
}

export function issueEventTarget(
  stub: WorkspaceStub,
  issueId: string
): AutomationEventTarget {
  return automationEventTarget(() => stub.getIssue(issueId));
}

export function repoTriggerEvent(
  eventName: string
): PileRepoTriggerEvent | null {
  return (
    EVENT_ALIASES.get(eventName) ??
    PILE_REPO_TRIGGER_EVENTS.find((event) => event === eventName) ??
    null
  );
}

export function mentionsHandle(body: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])${escaped}(?![\\w-])`, "i").test(body);
}

export function matchRepoTriggers(
  config: PileRepoConfig | null,
  event: PileRepoTriggerEvent,
  facts: AutomationEventFacts = {}
): PileRepoTrigger[] {
  return (config?.triggers ?? []).filter((trigger) => {
    if (trigger.on !== event) return false;
    if (event === "label.added" && trigger.label !== undefined) {
      return (
        facts.label !== undefined &&
        facts.label.toLowerCase() === trigger.label.toLowerCase()
      );
    }
    if (event === "mention") {
      return mentionsHandle(
        facts.body ?? "",
        trigger.handle ?? DEFAULT_MENTION_HANDLE
      );
    }
    return true;
  });
}

function triggerInstructions(
  trigger: PileRepoTrigger,
  context: string | undefined
): string {
  return context ? `${trigger.prompt}\n\n${context}` : trigger.prompt;
}

/**
 * `.pile/config.json` `triggers` (PILE-275): dispatch a lane per trigger
 * whose `on` matches the event. Config is read from the repo's default
 * branch — a PR must not be able to rewrite the prompts its own events run.
 * Returns the number of lanes dispatched.
 */
export async function fireRepoTriggers(
  env: WorkerEnv,
  stub: WorkspaceStub,
  organizationId: string,
  eventName: string,
  target: AutomationEventTarget,
  options: {
    context?: string;
    facts?: AutomationEventFacts;
    ctx?: { waitUntil: (promise: Promise<unknown>) => void };
    loadConfig?: (repo: string) => Promise<PileRepoConfig | null>;
  } = {}
): Promise<number> {
  const event = repoTriggerEvent(eventName);
  if (!event) return 0;
  const repo =
    target.repo !== undefined
      ? target.repo
      : ((await target.issue())?.repo ?? null);
  if (!repo) return 0;
  const loadConfig =
    options.loadConfig ?? ((r: string) => fetchPileRepoConfig(env, r));
  const config = await loadConfig(repo).catch(() => null);
  if (!config) return 0;
  const allowed = config.agents?.length ? config.agents : null;
  const triggers = matchRepoTriggers(config, event, options.facts).filter(
    (trigger) => {
      if (!allowed || allowed.includes(trigger.agent)) return true;
      console.warn("repo trigger agent not in .pile/config.json agents", {
        repo,
        event,
        agent: trigger.agent,
      });
      return false;
    }
  );
  if (triggers.length === 0) return 0;
  const issue = await target.issue();
  if (!issue) return 0;
  // PILE-321 — the event's repo is authoritative here (the trigger's config
  // was read from it), so a repo-less issue adopts it rather than the team
  // default. Persisted like the dispatch-time inheritance so redispatches
  // and lane-token minting see the repo the lane actually works; a failed
  // write (e.g. a repo+branch collision) must not stop the dispatch.
  let targetIssue = issue;
  if (!issue.repo) {
    const persisted = await stub
      .updateIssue(issue.id, { repo }, "automation")
      .catch((err: unknown) => {
        console.warn("repo trigger could not persist the event repo", {
          issueId: issue.id,
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      });
    targetIssue = persisted ?? { ...issue, repo };
  }
  // An event storm during a capacity outage would dispatch lanes onto the
  // substrate that's already failing — fleet breaker closes the loop.
  if ((await fleetInfraStreak(stub)) >= FLEET_UNHEALTHY_STREAK) {
    console.log("fleet breaker open — repo trigger skipped", {
      event,
      organizationId,
      triggers: triggers.length,
    });
    return 0;
  }

  let fired = 0;
  for (const trigger of triggers) {
    try {
      const providerConfig = await loadProviderConfig(env, stub, trigger.agent);
      // One active lane per issue: a second matching trigger on the same
      // issue is rejected (409) by dispatchAgent and logged below.
      await dispatchAgent(
        resolveAgentEnv(env, providerConfig ?? undefined),
        trigger.agent,
        organizationId,
        targetIssue,
        {
          id: "automation",
          organizationId,
          type: "agent",
          permissions: [],
        },
        trigger.model ?? config.model,
        options.ctx,
        {
          instructions: triggerInstructions(trigger, options.context),
          envAllowlist: config.env,
          purpose: `trigger:${event}`,
        }
      );
      fired += 1;
    } catch (err) {
      console.error("repo trigger dispatch failed", {
        repo,
        event,
        agent: trigger.agent,
        issueId: issue.id,
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return fired;
}
