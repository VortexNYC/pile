import { createD1 } from "../global/db.js";
import {
  createLabel,
  createProject,
  createCycle,
} from "../global/workspace-entities.js";
import { createComment } from "../global/comments.js";
import { createLinearUser } from "../global/linear-users.js";
import { createIssueRelation } from "../global/issue-relations.js";
import { createAttachment, setAttachmentR2Key } from "../global/attachments.js";
import { createIssueHistory } from "../global/issue-history.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../api/middleware.js";
import type { IssueInput, IssuePriority, IssueStatus } from "../workspace/types.js";

interface LinearState {
  id: string;
  name: string;
  type: string;
}

interface LinearLabel {
  id: string;
  name: string;
  color?: string;
}

interface LinearProject {
  id: string;
  name: string;
  state?: string;
  startDate?: string;
  targetDate?: string;
}

interface LinearCycle {
  id: string;
  name: string;
  startsAt?: string;
  endsAt?: string;
}

interface LinearUser {
  id: string;
  name?: string;
  email?: string;
}

interface LinearAttachment {
  id: string;
  url: string;
  title?: string | null;
  subtitle?: string | null;
  createdAt: string;
}

interface LinearComment {
  id: string;
  body: string;
  user?: { id: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface LinearHistory {
  id: string;
  createdAt: string;
  actor?: { id: string } | null;
  fromState?: { id: string; name?: string } | null;
  toState?: { id: string; name?: string } | null;
  fromPriority?: number | null;
  toPriority?: number | null;
  fromAssignee?: { id: string } | null;
  toAssignee?: { id: string } | null;
  fromProject?: { id: string; name?: string } | null;
  toProject?: { id: string; name?: string } | null;
  fromCycle?: { id: string; name?: string } | null;
  toCycle?: { id: string; name?: string } | null;
  fromTitle?: string | null;
  toTitle?: string | null;
  fromParent?: { id: string } | null;
  toParent?: { id: string } | null;
}

interface LinearIssue {
  id: string;
  title: string;
  description?: string | null;
  state: { id: string; name: string; type: string } | null;
  priority?: number | null;
  assignee?: { id: string } | null;
  project?: { id: string } | null;
  cycle?: { id: string } | null;
  labels: { nodes: Array<{ id: string }> };
  comments: { nodes: LinearComment[] };
  attachments: { nodes: LinearAttachment[] };
  history: { nodes: LinearHistory[] };
  parent?: { id: string } | null;
  children: { nodes: Array<{ id: string }> };
  createdAt: string;
  updatedAt: string;
}

interface MigrationCounts {
  issues: number;
  labels: number;
  projects: number;
  cycles: number;
  users: number;
  comments: number;
  relations: number;
  attachments: number;
  history: number;
}

class LinearClient {
  constructor(private token: string) {}

  private async request<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Linear request failed: ${res.status}`,
      });
    }

    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors && body.errors.length > 0) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Linear GraphQL error: ${JSON.stringify(body.errors)}`,
      });
    }
    if (body.data === undefined) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Linear returned no data",
      });
    }
    return body.data;
  }

  async getStates(teamId: string): Promise<LinearState[]> {
    const data = await this.request<{
      team: { states: { nodes: LinearState[] } } | null;
    }>(
      `query GetStates($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }`,
      { teamId }
    );
    return data.team?.states.nodes ?? [];
  }

  async getLabels(teamId: string): Promise<LinearLabel[]> {
    const data = await this.request<{
      issueLabels: { nodes: LinearLabel[] } | null;
    }>(
      `query GetLabels($teamId: ID!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            color
          }
        }
      }`,
      { teamId }
    );
    return data.issueLabels?.nodes ?? [];
  }

  async getProjects(teamId: string): Promise<LinearProject[]> {
    const data = await this.request<{
      team: { projects: { nodes: LinearProject[] } | null } | null;
    }>(
      `query GetProjects($teamId: String!) {
        team(id: $teamId) {
          projects {
            nodes {
              id
              name
              state
              startDate
              targetDate
            }
          }
        }
      }`,
      { teamId }
    );
    return data.team?.projects?.nodes ?? [];
  }

  async getCycles(teamId: string): Promise<LinearCycle[]> {
    const data = await this.request<{
      team: { cycles: { nodes: LinearCycle[] } | null } | null;
    }>(
      `query GetCycles($teamId: String!) {
        team(id: $teamId) {
          cycles {
            nodes {
              id
              name
              startsAt
              endsAt
            }
          }
        }
      }`,
      { teamId }
    );
    return data.team?.cycles?.nodes ?? [];
  }

  async getUsers(teamId: string): Promise<LinearUser[]> {
    const data = await this.request<{
      team: {
        members: {
          nodes: LinearUser[];
        } | null;
      } | null;
    }>(
      `query GetUsers($teamId: String!) {
        team(id: $teamId) {
          members {
            nodes {
              id
              name
              email
            }
          }
        }
      }`,
      { teamId }
    );
    return data.team?.members?.nodes ?? [];
  }

  async getIssuesPage(
    teamId: string,
    cursor?: string
  ): Promise<{
    issues: LinearIssue[];
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  }> {
    const data = await this.request<{
      team: {
        issues: {
          nodes: LinearIssue[];
          pageInfo: { hasNextPage: boolean; endCursor?: string };
        } | null;
      } | null;
    }>(
      `query GetIssues($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 100, after: $after) {
            nodes {
              id
              title
              description
              state {
                id
                name
                type
              }
              priority
              assignee {
                id
              }
              project {
                id
              }
              cycle {
                id
              }
              labels {
                nodes {
                  id
                }
              }
              comments(first: 20) {
                nodes {
                  id
                  body
                  user {
                    id
                  }
                  createdAt
                  updatedAt
                }
              }
              parent {
                id
              }
              children(first: 10) {
                nodes {
                  id
                }
              }
              attachments(first: 20) {
                nodes {
                  id
                  url
                  title
                  subtitle
                  createdAt
                }
              }
              history(first: 15) {
                nodes {
                  id
                  createdAt
                  actor {
                    id
                  }
                  fromState {
                    id
                  }
                  toState {
                    id
                  }
                  fromPriority
                  toPriority
                  fromAssignee {
                    id
                  }
                  toAssignee {
                    id
                  }
                  fromProject {
                    id
                  }
                  toProject {
                    id
                  }
                  fromCycle {
                    id
                  }
                  toCycle {
                    id
                  }
                  fromTitle
                  toTitle
                  fromParent {
                    id
                  }
                  toParent {
                    id
                  }
                }
              }
              createdAt
              updatedAt
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      { teamId, after: cursor ?? null }
    );
    return {
      issues: data.team?.issues?.nodes ?? [],
      pageInfo: data.team?.issues?.pageInfo ?? {
        hasNextPage: false,
      },
    };
  }
}

function mapStatus(state: LinearState | null): IssueStatus | undefined {
  if (!state) return undefined;

  const typeMap: Record<string, IssueStatus> = {
    backlog: "backlog",
    unstarted: "todo",
    started: "in_progress",
    completed: "done",
    canceled: "canceled",
  };

  const byType = typeMap[state.type.toLowerCase()];
  if (byType) return byType;

  const name = state.name.toLowerCase();
  if (name in typeMap) return typeMap[name];

  return undefined;
}

function mapPriority(priority: number | null | undefined): IssuePriority | undefined {
  if (priority == null) return undefined;
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  if (priority === 4) return "low";
  return undefined;
}

export async function migrateLinear(
  env: WorkerEnv,
  workspaceId: string,
  linearToken: string,
  teamId: string
): Promise<MigrationCounts> {
  const client = new LinearClient(linearToken);
  const db = createD1(env.D1);

  const [states, labels, projects, cycles, linearUsers] = await Promise.all([
    client.getStates(teamId),
    client.getLabels(teamId),
    client.getProjects(teamId),
    client.getCycles(teamId),
    client.getUsers(teamId),
  ]);

  for (const lu of linearUsers) {
    await createLinearUser(db, workspaceId, {
      linearId: lu.id,
      name: lu.name,
      email: lu.email,
    });
  }

  const stateMap = new Map(states.map((s) => [s.id, s]));

  const labelMap = new Map<string, string>();
  for (const label of labels) {
    const created = await createLabel(db, workspaceId, {
      name: label.name,
      color: label.color,
    });
    if (created) {
      labelMap.set(label.id, created.id);
    }
  }

  const projectMap = new Map<string, string>();
  for (const project of projects) {
    const created = await createProject(db, workspaceId, {
      name: project.name,
      status: project.state ?? "active",
      startDate: project.startDate,
      endDate: project.targetDate,
    });
    if (created) {
      projectMap.set(project.id, created.id);
    }
  }

  const cycleMap = new Map<string, string>();
  for (const cycle of cycles) {
    const created = await createCycle(db, workspaceId, {
      name: cycle.name,
      startDate: cycle.startsAt,
      endDate: cycle.endsAt,
    });
    if (created) {
      cycleMap.set(cycle.id, created.id);
    }
  }

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setWorkspaceId(workspaceId);

  let issueCount = 0;
  let commentCount = 0;
  let relationCount = 0;
  let attachmentCount = 0;
  let historyCount = 0;
  let cursor: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const page = await client.getIssuesPage(teamId, cursor);
    for (const li of page.issues) {
      const labelIds = li.labels.nodes
        .map((n) => labelMap.get(n.id))
        .filter((id): id is string => typeof id === "string")
        .join(",");

      const input: IssueInput = {
        id: li.id,
        title: li.title,
        description: li.description || undefined,
        status: mapStatus(li.state ? stateMap.get(li.state.id) ?? null : null),
        priority: mapPriority(li.priority),
        assigneeId: li.assignee?.id ?? undefined,
        projectId: li.project?.id
          ? projectMap.get(li.project.id)
          : undefined,
        cycleId: li.cycle?.id ? cycleMap.get(li.cycle.id) : undefined,
        labelIds: labelIds || undefined,
        createdAt: li.createdAt,
        updatedAt: li.updatedAt,
      };

      await stub.createIssue(input);
      issueCount++;

      for (const lc of li.comments.nodes) {
        await createComment(db, workspaceId, {
          issueId: li.id,
          authorId: lc.user?.id ?? "unknown",
          body: lc.body,
          createdAt: lc.createdAt,
          updatedAt: lc.updatedAt,
        });
        commentCount++;
      }

      const relationPairs: Array<[string, string]> = [];
      if (li.parent?.id) relationPairs.push([li.parent.id, "parent"]);
      for (const c of li.children.nodes) relationPairs.push([c.id, "child"]);

      for (const [toIssueId, type] of relationPairs) {
        await createIssueRelation(db, workspaceId, {
          fromIssueId: li.id,
          toIssueId,
          type,
        });
        relationCount++;
      }

      for (const la of li.attachments.nodes) {
        const created = await createAttachment(db, workspaceId, {
          issueId: li.id,
          linearId: la.id,
          url: la.url,
          title: la.title,
          subtitle: la.subtitle,
          createdAt: la.createdAt,
        });
        if (!created) {
          continue;
        }
        attachmentCount++;

        if (env.ATTACHMENTS_BUCKET) {
          const dl = await fetch(la.url, { method: "GET" });
          const ct = dl.headers.get("Content-Type") ?? "";
          if (dl.body && ct && !ct.includes("text/html")) {
            const r2Key = `attachments/${workspaceId}/${li.id}/${created.id}`;
            await env.ATTACHMENTS_BUCKET.put(r2Key, dl.body, {
              httpMetadata: { contentType: ct },
            });
            await setAttachmentR2Key(db, workspaceId, created.id, r2Key);
          }
        }
      }

      for (const lh of li.history.nodes) {
        const changes: Array<{
          field: string;
          from?: string | null;
          to?: string | null;
        }> = [
          {
            field: "state",
            from: lh.fromState?.id ?? null,
            to: lh.toState?.id ?? null,
          },
          {
            field: "priority",
            from:
              lh.fromPriority === undefined || lh.fromPriority === null
                ? null
                : String(lh.fromPriority),
            to:
              lh.toPriority === undefined || lh.toPriority === null
                ? null
                : String(lh.toPriority),
          },
          {
            field: "assignee",
            from: lh.fromAssignee?.id ?? null,
            to: lh.toAssignee?.id ?? null,
          },
          {
            field: "project",
            from: lh.fromProject?.id ?? null,
            to: lh.toProject?.id ?? null,
          },
          {
            field: "cycle",
            from: lh.fromCycle?.id ?? null,
            to: lh.toCycle?.id ?? null,
          },
          {
            field: "title",
            from: lh.fromTitle ?? null,
            to: lh.toTitle ?? null,
          },
          {
            field: "parent",
            from: lh.fromParent?.id ?? null,
            to: lh.toParent?.id ?? null,
          },
        ];

        for (const change of changes) {
          if (change.from !== null || change.to !== null) {
            await createIssueHistory(db, workspaceId, {
              issueId: li.id,
              linearId: lh.id,
              field: change.field,
              fromValue: change.from,
              toValue: change.to,
              actorId: lh.actor?.id ?? null,
              createdAt: lh.createdAt,
            });
            historyCount++;
          }
        }
      }
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return {
    issues: issueCount,
    labels: labels.length,
    projects: projects.length,
    cycles: cycles.length,
    users: linearUsers.length,
    comments: commentCount,
    relations: relationCount,
    attachments: attachmentCount,
    history: historyCount,
  };
}
