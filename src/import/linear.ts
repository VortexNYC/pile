import { z } from "zod";

import { getDefaultTeam } from "../global/teams.js";
import { createTemplate } from "../global/templates.js";
import { createUser, findUserByEmail } from "../global/users.js";
import {
  createCycle,
  createLabel,
  createMembership,
  createProject,
  createState,
} from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type {
  IssueInput,
  IssuePriority,
  IssueStatus,
} from "../types/workspace.js";
import type {
  ImportContext,
  ImportCounts,
  ImportSource,
  ImportValidationResult,
} from "./types.js";
import { unwrap } from "./utils.js";

export const linearCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type LinearCredentials = z.infer<typeof linearCredentialsSchema>;

export const linearOptionsSchema = z.object({
  linearTeamId: z.string().min(1),
  teamId: z.string().optional(),
});

export type LinearOptions = z.infer<typeof linearOptionsSchema>;

const linearUserSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
});

const linearStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
});

const linearLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
});

const linearProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
});

const linearCycleSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
});

const linearTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  templateData: z.string().nullable().optional(),
});

const linearAttachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  createdAt: z.string(),
});

const linearCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  user: z.object({ id: z.string() }).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const linearRelationSchema = z.object({
  id: z.string(),
  type: z.string(),
  relatedIssue: z.object({ id: z.string() }).nullable().optional(),
  issue: z.object({ id: z.string() }).nullable().optional(),
});

const linearHistorySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  actor: z.object({ id: z.string() }).nullable().optional(),
  fromState: z
    .object({ id: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  toState: z
    .object({ id: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  fromPriority: z.number().nullable().optional(),
  toPriority: z.number().nullable().optional(),
  fromAssignee: z.object({ id: z.string() }).nullable().optional(),
  toAssignee: z.object({ id: z.string() }).nullable().optional(),
  fromProject: z
    .object({ id: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  toProject: z
    .object({ id: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  fromCycle: z
    .object({ id: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  toCycle: z
    .object({ id: z.string(), name: z.string().optional() })
    .nullable()
    .optional(),
  fromTitle: z.string().nullable().optional(),
  toTitle: z.string().nullable().optional(),
  fromParent: z.object({ id: z.string() }).nullable().optional(),
  toParent: z.object({ id: z.string() }).nullable().optional(),
});

const linearIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state: linearStateSchema.nullable().optional(),
  priority: z.number().nullable().optional(),
  estimate: z.number().nullable().optional(),
  assignee: z.object({ id: z.string() }).nullable().optional(),
  project: z.object({ id: z.string() }).nullable().optional(),
  cycle: z.object({ id: z.string() }).nullable().optional(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
  comments: z.object({ nodes: z.array(linearCommentSchema) }),
  attachments: z.object({ nodes: z.array(linearAttachmentSchema) }),
  history: z.object({ nodes: z.array(linearHistorySchema) }),
  subscribers: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
  parent: z.object({ id: z.string() }).nullable().optional(),
  children: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
  relations: z.object({ nodes: z.array(linearRelationSchema) }),
  inverseRelations: z.object({ nodes: z.array(linearRelationSchema) }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

class LinearClient {
  constructor(private token: string) {}

  private async request<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    schema: z.ZodType<T>
  ): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    const detail = await res.text().catch(() => "");
    if (!res.ok) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Linear request failed: ${res.status}: ${detail.slice(0, 500)}`,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(detail);
    } catch {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Linear returned invalid JSON",
      });
    }

    const parsed = z
      .object({
        data: schema,
        errors: z.array(z.unknown()).optional(),
      })
      .safeParse(json);

    if (!parsed.success) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Linear returned unexpected response: ${parsed.error.message}`,
      });
    }

    if (parsed.data.errors && parsed.data.errors.length > 0) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Linear GraphQL error: ${JSON.stringify(parsed.data.errors)}`,
      });
    }

    return parsed.data.data;
  }

  async getStates(teamId: string) {
    return this.request(
      `query GetStates($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
              color
              position
            }
          }
        }
      }`,
      { teamId },
      z.object({
        team: z
          .object({
            states: z.object({
              nodes: z.array(linearStateSchema),
            }),
          })
          .nullable(),
      })
    );
  }

  async getLabels(teamId: string) {
    return this.request(
      `query GetLabels($teamId: ID!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            color
          }
        }
      }`,
      { teamId },
      z.object({
        issueLabels: z
          .object({
            nodes: z.array(linearLabelSchema),
          })
          .nullable(),
      })
    );
  }

  async getProjects(teamId: string) {
    return this.request(
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
      { teamId },
      z.object({
        team: z
          .object({
            projects: z.object({
              nodes: z.array(linearProjectSchema),
            }),
          })
          .nullable(),
      })
    );
  }

  async getCycles(teamId: string) {
    return this.request(
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
      { teamId },
      z.object({
        team: z
          .object({
            cycles: z.object({
              nodes: z.array(linearCycleSchema),
            }),
          })
          .nullable(),
      })
    );
  }

  async getUsers(teamId: string) {
    return this.request(
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
      { teamId },
      z.object({
        team: z
          .object({
            members: z.object({
              nodes: z.array(linearUserSchema),
            }),
          })
          .nullable(),
      })
    );
  }

  async getTemplates(teamId: string) {
    return this.request(
      `query GetTemplates($teamId: String!) {
        team(id: $teamId) {
          templates(first: 50) {
            nodes {
              id
              name
              templateData
            }
          }
        }
      }`,
      { teamId },
      z.object({
        team: z
          .object({
            templates: z.object({
              nodes: z.array(linearTemplateSchema),
            }),
          })
          .nullable(),
      })
    );
  }

  async getIssuesPage(teamId: string, cursor?: string) {
    return this.request(
      `query GetIssues($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 50, after: $after) {
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
              estimate
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
              relations(first: 20) {
                nodes {
                  id
                  type
                  relatedIssue {
                    id
                  }
                }
              }
              inverseRelations(first: 20) {
                nodes {
                  id
                  type
                  issue {
                    id
                  }
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
                    name
                  }
                  toState {
                    id
                    name
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
                    name
                  }
                  toProject {
                    id
                    name
                  }
                  fromCycle {
                    id
                    name
                  }
                  toCycle {
                    id
                    name
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
              subscribers(first: 10) {
                nodes {
                  id
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
      { teamId, after: cursor ?? null },
      z.object({
        team: z
          .object({
            issues: z.object({
              nodes: z.array(linearIssueSchema),
              pageInfo: z.object({
                hasNextPage: z.boolean(),
                endCursor: z.string().nullable().optional(),
              }),
            }),
          })
          .nullable(),
      })
    );
  }
}

function mapStatus(
  state: z.infer<typeof linearStateSchema> | null | undefined
): IssueStatus | undefined {
  if (!state) return undefined;

  const typeMap: Record<string, IssueStatus> = {
    triage: "triage",
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

function mapPriority(
  priority: number | null | undefined
): IssuePriority | undefined {
  if (priority == null) return undefined;
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  if (priority === 4) return "low";
  return undefined;
}

function mapRelationType(type: string): string | undefined {
  const lower = type.toLowerCase();
  if (lower.includes("duplicate")) return "duplicate";
  if (lower.includes("blocks") || lower.includes("blocked by")) return "blocks";
  if (lower.includes("similar")) return "similar";
  if (lower.includes("relates") || lower.includes("related")) return "related";
  return undefined;
}

async function resolveUserId(
  ctx: ImportContext,
  cache: Map<string, string | null>,
  linearId: string | null | undefined
): Promise<string | null> {
  if (!linearId) return null;
  if (cache.has(linearId)) return cache.get(linearId) ?? null;

  // We only pre-populate the cache from team members; if a user is not in the
  // team member list we do not have enough info to create a Vortex user.
  cache.set(linearId, null);
  return null;
}

async function importComments(
  ctx: ImportContext,
  issueId: string,
  comments: z.infer<typeof linearCommentSchema>[],
  userCache: Map<string, string | null>
): Promise<number> {
  let count = 0;
  for (const comment of comments) {
    const authorId = await resolveUserId(ctx, userCache, comment.user?.id);
    await ctx.stub.createComment({
      issueId,
      authorId,
      body: comment.body,
      externalSource: "linear",
      externalId: comment.id,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });
    count++;
  }
  return count;
}

async function importAttachments(
  ctx: ImportContext,
  issueId: string,
  attachments: z.infer<typeof linearAttachmentSchema>[]
): Promise<number> {
  let count = 0;
  for (const attachment of attachments) {
    const created = await ctx.stub.createAttachment({
      issueId,
      linearId: attachment.id,
      url: attachment.url,
      title: attachment.title,
      subtitle: attachment.subtitle,
      createdAt: attachment.createdAt,
    });
    if (!created) continue;
    count++;

    if (ctx.env.ATTACHMENTS_BUCKET) {
      const dl = await fetch(attachment.url, { method: "GET" });
      const ct = dl.headers.get("Content-Type") ?? "";
      if (dl.body && ct && !ct.includes("text/html")) {
        const r2Key = `attachments/${ctx.organizationId}/${issueId}/${created.id}`;
        await ctx.env.ATTACHMENTS_BUCKET.put(r2Key, dl.body, {
          httpMetadata: { contentType: ct },
        });
        await ctx.stub.setAttachmentR2Key(created.id, r2Key);
      }
    }
  }
  return count;
}

async function importHistory(
  ctx: ImportContext,
  issueId: string,
  history: z.infer<typeof linearHistorySchema>[],
  userCache: Map<string, string | null>
): Promise<number> {
  let count = 0;
  for (const item of history) {
    const actorId = await resolveUserId(ctx, userCache, item.actor?.id);
    const changes: Array<{
      field: string;
      from?: string | null;
      to?: string | null;
    }> = [
      {
        field: "state",
        from: item.fromState?.id ?? null,
        to: item.toState?.id ?? null,
      },
      {
        field: "priority",
        from:
          item.fromPriority === undefined || item.fromPriority === null
            ? null
            : String(item.fromPriority),
        to:
          item.toPriority === undefined || item.toPriority === null
            ? null
            : String(item.toPriority),
      },
      {
        field: "assignee",
        from: item.fromAssignee?.id ?? null,
        to: item.toAssignee?.id ?? null,
      },
      {
        field: "project",
        from: item.fromProject?.id ?? null,
        to: item.toProject?.id ?? null,
      },
      {
        field: "cycle",
        from: item.fromCycle?.id ?? null,
        to: item.toCycle?.id ?? null,
      },
      {
        field: "title",
        from: item.fromTitle ?? null,
        to: item.toTitle ?? null,
      },
      {
        field: "parent",
        from: item.fromParent?.id ?? null,
        to: item.toParent?.id ?? null,
      },
    ];

    for (const change of changes) {
      if (change.from !== null || change.to !== null) {
        await ctx.stub.createIssueHistory({
          issueId,
          linearId: item.id,
          field: change.field,
          fromValue: change.from,
          toValue: change.to,
          actorId,
          createdAt: item.createdAt,
        });
        count++;
      }
    }
  }
  return count;
}

export const linearImportSource: ImportSource<
  LinearCredentials,
  LinearOptions
> = {
  name: "linear",

  validate(credentials): ImportValidationResult {
    const parsed = linearCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options): Promise<ImportCounts> {
    const parsedOptions = linearOptionsSchema.parse(options ?? {});
    const linearTeamId = parsedOptions.linearTeamId;
    const client = new LinearClient(credentials.token);

    const teamId =
      parsedOptions.teamId ??
      (await getDefaultTeam(ctx.db, ctx.organizationId))?.id;
    if (!teamId) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Workspace has no default team and no teamId was provided",
      });
    }

    const [
      statesData,
      labelsData,
      projectsData,
      cyclesData,
      usersData,
      templatesData,
    ] = await Promise.all([
      client.getStates(linearTeamId),
      client.getLabels(linearTeamId),
      client.getProjects(linearTeamId),
      client.getCycles(linearTeamId),
      client.getUsers(linearTeamId),
      client.getTemplates(linearTeamId),
    ]);

    const states = statesData.team?.states.nodes ?? [];
    const labels = labelsData.issueLabels?.nodes ?? [];
    const projects = projectsData.team?.projects?.nodes ?? [];
    const cycles = cyclesData.team?.cycles.nodes ?? [];
    const linearUsers = usersData.team?.members.nodes ?? [];
    const templates = templatesData.team?.templates.nodes ?? [];

    const userCache = new Map<string, string | null>();
    let membershipCount = 0;

    for (const lu of linearUsers) {
      await ctx.stub.createLinearUser({
        linearId: lu.id,
        name: lu.name,
        email: lu.email,
      });

      if (lu.email) {
        const existing = await findUserByEmail(ctx.db, lu.email);
        const localUser =
          existing ??
          unwrap(
            await createUser(ctx.db, {
              name: lu.name ?? "",
              email: lu.email,
              emailVerified: true,
            }),
            "Failed to create user"
          );
        await createMembership(
          ctx.db,
          ctx.organizationId,
          localUser.id,
          "member"
        );
        userCache.set(lu.id, localUser.id);
        membershipCount++;
      } else {
        userCache.set(lu.id, null);
      }
    }

    const stateMap = new Map(states.map((s) => [s.id, s]));

    const labelMap = new Map<string, string>();
    for (const label of labels) {
      const created = unwrap(
        await createLabel(ctx.db, ctx.organizationId, {
          name: label.name,
          color: label.color ?? null,
        }),
        "Failed to create label"
      );
      labelMap.set(label.id, created.id);
    }

    for (const state of states) {
      unwrap(
        await createState(ctx.db, ctx.organizationId, {
          linearId: state.id,
          name: state.name,
          type: state.type,
          color: state.color ?? null,
          position:
            state.position === undefined || state.position === null
              ? null
              : String(state.position),
        }),
        "Failed to create state"
      );
    }

    for (const tmpl of templates) {
      unwrap(
        await createTemplate(ctx.db, ctx.organizationId, {
          linearId: tmpl.id,
          name: tmpl.name,
          templateData: tmpl.templateData ?? null,
        }),
        "Failed to create template"
      );
    }

    const projectMap = new Map<string, string>();
    for (const project of projects) {
      const created = unwrap(
        await createProject(ctx.db, ctx.organizationId, {
          name: project.name,
          status: project.state ?? "active",
          startDate: project.startDate ?? null,
          endDate: project.targetDate ?? null,
        }),
        "Failed to create project"
      );
      projectMap.set(project.id, created.id);
    }

    const cycleMap = new Map<string, string>();
    for (const cycle of cycles) {
      const created = unwrap(
        await createCycle(ctx.db, ctx.organizationId, {
          name: cycle.name,
          startDate: cycle.startsAt ?? null,
          endDate: cycle.endsAt ?? null,
        }),
        "Failed to create cycle"
      );
      cycleMap.set(cycle.id, created.id);
    }

    let issueCount = 0;
    let commentCount = 0;
    let parentLinkCount = 0;
    let relationCount = 0;
    let attachmentCount = 0;
    let historyCount = 0;
    let subscriberCount = 0;
    let cursor: string | undefined;
    let hasNextPage = true;
    const issueIds = new Set<string>();
    const parentLinks = new Map<string, string>();
    const relationLinks = new Map<
      string,
      { fromIssueId: string; toIssueId: string; type: string }
    >();

    while (hasNextPage) {
      const page = await client.getIssuesPage(linearTeamId, cursor);
      const issues = page.team?.issues.nodes ?? [];
      const pageInfo = page.team?.issues.pageInfo ?? { hasNextPage: false };

      for (const issue of issues) {
        const labelIds = issue.labels.nodes
          .map((n) => labelMap.get(n.id))
          .filter((id): id is string => typeof id === "string")
          .join(",");

        const input: IssueInput = {
          id: issue.id,
          teamId,
          title: issue.title,
          description: issue.description ?? undefined,
          status: mapStatus(
            issue.state ? (stateMap.get(issue.state.id) ?? null) : null
          ),
          priority: mapPriority(issue.priority),
          estimate: issue.estimate ?? undefined,
          assigneeId:
            (await resolveUserId(ctx, userCache, issue.assignee?.id)) ??
            undefined,
          projectId: issue.project?.id
            ? projectMap.get(issue.project.id)
            : undefined,
          cycleId: issue.cycle?.id ? cycleMap.get(issue.cycle.id) : undefined,
          labelIds: labelIds || undefined,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
        };

        try {
          const createdIssue = await ctx.stub.createIssue(
            input,
            ctx.importerId
          );
          issueCount++;
          issueIds.add(issue.id);

          for (const rel of issue.relations.nodes) {
            if (rel.relatedIssue?.id) {
              const type = mapRelationType(rel.type);
              if (type) {
                relationLinks.set(rel.id, {
                  fromIssueId: issue.id,
                  toIssueId: rel.relatedIssue.id,
                  type,
                });
              }
            }
          }

          for (const rel of issue.inverseRelations.nodes) {
            if (rel.issue?.id) {
              const type = mapRelationType(rel.type);
              if (type) {
                // Normalize inverse direction so type describes the outgoing edge.
                relationLinks.set(rel.id, {
                  fromIssueId: issue.id,
                  toIssueId: rel.issue.id,
                  type: type === "blocks" ? "blocks" : type,
                });
              }
            }
          }

          if (issue.parent?.id) {
            parentLinks.set(issue.id, issue.parent.id);
          }

          commentCount += await importComments(
            ctx,
            createdIssue.id,
            issue.comments.nodes,
            userCache
          );
          attachmentCount += await importAttachments(
            ctx,
            createdIssue.id,
            issue.attachments.nodes
          );
          historyCount += await importHistory(
            ctx,
            createdIssue.id,
            issue.history.nodes,
            userCache
          );

          for (const sub of issue.subscribers.nodes) {
            await ctx.stub.createIssueSubscriber({
              issueId: createdIssue.id,
              linearUserId: sub.id,
            });
            subscriberCount++;
          }
        } catch (err) {
          if (err instanceof Error) {
            console.error(
              `Failed to import Linear issue ${issue.id}: ${err.message}`
            );
          }
        }
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor ?? undefined;
    }

    for (const rel of relationLinks.values()) {
      if (!issueIds.has(rel.fromIssueId) || !issueIds.has(rel.toIssueId)) {
        continue;
      }
      try {
        await ctx.stub.createIssueRelation(rel);
        relationCount++;
      } catch {
        // Skip invalid or malformed relation edges.
      }
    }

    for (const [childId, parentId] of parentLinks) {
      if (!issueIds.has(childId) || !issueIds.has(parentId)) continue;
      try {
        await ctx.stub.updateIssue(childId, { parentId }, ctx.importerId);
        parentLinkCount++;
      } catch {
        // Parent may create a cycle or be in a different team; skip.
      }
    }

    return {
      issues: issueCount,
      labels: labels.length,
      states: states.length,
      projects: projects.length,
      cycles: cycles.length,
      users: linearUsers.length,
      comments: commentCount,
      relations: relationCount,
      attachments: attachmentCount,
      history: historyCount,
      subscribers: subscriberCount,
      memberships: membershipCount,
      templates: templates.length,
      parentLinks: parentLinkCount,
    };
  },
};
