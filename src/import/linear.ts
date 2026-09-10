import { z } from "zod";

import {
  findImportMapping,
  findImportMappingsByJob,
  recordImportMapping,
  type ImportMappingType,
} from "../global/import-mappings.js";
import {
  recordImportParentLink,
  resolveImportParentLinks,
} from "../global/import-parent-links.js";
import { createTeam, getDefaultTeam, getTeamById } from "../global/teams.js";
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
  ImportBatchResult,
  ImportContext,
  ImportRunState,
  ImportSource,
  ImportValidationResult,
} from "./types.js";
import { unwrap } from "./utils.js";

export const linearCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type LinearCredentials = z.infer<typeof linearCredentialsSchema>;

export const linearOptionsSchema = z.object({
  linearTeamId: z.string().min(1).optional(),
  teamId: z.string().optional(),
  workspace: z.boolean().optional(),
  teamIds: z.array(z.string()).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().optional(),
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

const linearTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string().optional(),
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

  async getIssuesPage(teamId: string, cursor?: string, first = 50) {
    return this.request(
      `query GetIssues($teamId: String!, $after: String, $first: Int!) {
        team(id: $teamId) {
          issues(first: $first, after: $after) {
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
      { teamId, after: cursor ?? null, first },
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

  async getTeams(cursor?: string, first = 50) {
    return this.request(
      `query GetTeams($after: String, $first: Int!) {
        teams(first: $first, after: $after) {
          nodes {
            id
            name
            key
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { after: cursor ?? null, first },
      z.object({
        teams: z.object({
          nodes: z.array(linearTeamSchema),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable().optional(),
          }),
        }),
      })
    );
  }

  async getTeam(id: string) {
    return this.request(
      `query GetTeam($id: String!) {
        team(id: $id) {
          id
          name
          key
        }
      }`,
      { id },
      z.object({
        team: linearTeamSchema.nullable(),
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

  async run(
    ctx,
    credentials,
    options,
    runState?: ImportRunState
  ): Promise<ImportBatchResult> {
    const parsedOptions = linearOptionsSchema.parse(options ?? {});
    const client = new LinearClient(credentials.token);

    if (parsedOptions.workspace) {
      return importLinearWorkspace(
        ctx,
        client,
        credentials,
        parsedOptions,
        runState
      );
    }

    const linearTeamId = parsedOptions.linearTeamId;
    if (!linearTeamId) {
      return {
        counts: { errors: 1 },
        nextCursor: null,
      };
    }

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

    const existingMappings = await findImportMappingsByJob(ctx.db, ctx.jobId);
    const byType = new Map<ImportMappingType, Map<string, string>>();
    for (const m of existingMappings) {
      if (!byType.has(m.type as ImportMappingType)) {
        byType.set(m.type as ImportMappingType, new Map());
      }
      byType.get(m.type as ImportMappingType)!.set(m.externalId, m.vortexId);
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
    let newUsers = 0;
    let newMemberships = 0;

    for (const lu of linearUsers) {
      const existingUserId = byType.get("user")?.get(lu.id);
      if (existingUserId) {
        userCache.set(lu.id, existingUserId);
        continue;
      }

      await ctx.stub.createLinearUser({
        linearId: lu.id,
        name: lu.name,
        email: lu.email,
      });

      let vortexId: string | null = null;
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
        vortexId = localUser.id;
        userCache.set(lu.id, vortexId);
        if (!existing) {
          newUsers++;
        }
        const createdMembership = await createMembership(
          ctx.db,
          ctx.organizationId,
          localUser.id,
          "member"
        );
        if (createdMembership) {
          newMemberships++;
        }
        await recordImportMapping(
          ctx.db,
          ctx.organizationId,
          ctx.jobId,
          "linear",
          "user",
          lu.id,
          vortexId
        );
      } else {
        userCache.set(lu.id, null);
      }
    }

    const stateMap = new Map(states.map((s) => [s.id, s]));
    let newStates = 0;

    for (const state of states) {
      if (byType.get("state")?.has(state.id)) {
        continue;
      }
      const created = unwrap(
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
      newStates++;
      await recordImportMapping(
        ctx.db,
        ctx.organizationId,
        ctx.jobId,
        "linear",
        "state",
        state.id,
        created.id
      );
    }

    const labelMap = new Map<string, string>();
    let newLabels = 0;
    for (const label of labels) {
      const existingLabelId = byType.get("label")?.get(label.id);
      if (existingLabelId) {
        labelMap.set(label.id, existingLabelId);
        continue;
      }
      const created = unwrap(
        await createLabel(ctx.db, ctx.organizationId, {
          name: label.name,
          color: label.color ?? null,
        }),
        "Failed to create label"
      );
      labelMap.set(label.id, created.id);
      newLabels++;
      await recordImportMapping(
        ctx.db,
        ctx.organizationId,
        ctx.jobId,
        "linear",
        "label",
        label.id,
        created.id
      );
    }

    let newTemplates = 0;
    for (const tmpl of templates) {
      if (byType.get("template")?.has(tmpl.id)) {
        continue;
      }
      const created = unwrap(
        await createTemplate(ctx.db, ctx.organizationId, {
          linearId: tmpl.id,
          name: tmpl.name,
          templateData: tmpl.templateData ?? null,
        }),
        "Failed to create template"
      );
      newTemplates++;
      await recordImportMapping(
        ctx.db,
        ctx.organizationId,
        ctx.jobId,
        "linear",
        "template",
        tmpl.id,
        created.id
      );
    }

    const projectMap = new Map<string, string>();
    let newProjects = 0;
    for (const project of projects) {
      const existingProjectId = byType.get("project")?.get(project.id);
      if (existingProjectId) {
        projectMap.set(project.id, existingProjectId);
        continue;
      }
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
      newProjects++;
      await recordImportMapping(
        ctx.db,
        ctx.organizationId,
        ctx.jobId,
        "linear",
        "project",
        project.id,
        created.id
      );
    }

    const cycleMap = new Map<string, string>();
    let newCycles = 0;
    for (const cycle of cycles) {
      const existingCycleId = byType.get("cycle")?.get(cycle.id);
      if (existingCycleId) {
        cycleMap.set(cycle.id, existingCycleId);
        continue;
      }
      const created = unwrap(
        await createCycle(ctx.db, ctx.organizationId, {
          name: cycle.name,
          startDate: cycle.startsAt ?? null,
          endDate: cycle.endsAt ?? null,
        }),
        "Failed to create cycle"
      );
      cycleMap.set(cycle.id, created.id);
      newCycles++;
      await recordImportMapping(
        ctx.db,
        ctx.organizationId,
        ctx.jobId,
        "linear",
        "cycle",
        cycle.id,
        created.id
      );
    }

    const limit = runState?.limit ?? parsedOptions.limit;

    let issueCount = 0;
    let commentCount = 0;
    let parentLinkCount = 0;
    let relationCount = 0;
    let attachmentCount = 0;
    let historyCount = 0;
    let subscriberCount = 0;
    let cursor = runState?.cursor ?? parsedOptions.cursor ?? undefined;
    let hasNextPage = true;
    let nextCursor: string | null = null;
    const issueIdMap = new Map<string, string>();
    const relationLinks = new Map<
      string,
      { fromIssueId: string; toExternalId: string; type: string }
    >();

    while (hasNextPage) {
      const remaining = limit ? limit - issueCount : undefined;
      const first = remaining ? Math.min(50, remaining) : 50;
      const page = await client.getIssuesPage(linearTeamId, cursor, first);
      const issues = page.team?.issues.nodes ?? [];
      const pageInfo = page.team?.issues.pageInfo ?? { hasNextPage: false };

      for (const issue of issues) {
        const labelIds = issue.labels.nodes
          .map((n) => labelMap.get(n.id))
          .filter((id): id is string => typeof id === "string")
          .join(",");

        const input: IssueInput = {
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
          issueIdMap.set(issue.id, createdIssue.id);

          await recordImportMapping(
            ctx.db,
            ctx.organizationId,
            ctx.jobId,
            "linear",
            "issue",
            issue.id,
            createdIssue.id
          );

          for (const rel of issue.relations.nodes) {
            if (rel.relatedIssue?.id) {
              const type = mapRelationType(rel.type);
              if (type) {
                relationLinks.set(rel.id, {
                  fromIssueId: createdIssue.id,
                  toExternalId: rel.relatedIssue.id,
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
                  fromIssueId: createdIssue.id,
                  toExternalId: rel.issue.id,
                  type: type === "blocks" ? "blocks" : type,
                });
              }
            }
          }

          if (issue.parent?.id) {
            await recordImportParentLink(
              ctx.db,
              ctx.organizationId,
              ctx.jobId,
              createdIssue.id,
              issue.parent.id
            );
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

      parentLinkCount += await resolveImportParentLinks(
        ctx.db,
        ctx.jobId,
        async (parentId) => {
          const localId = issueIdMap.get(parentId);
          if (localId) return localId;
          const mapping = await findImportMapping(ctx.db, ctx.jobId, parentId);
          return mapping?.vortexId;
        },
        async (childId, parentVortexId) => {
          await ctx.stub.updateIssue(
            childId,
            { parentId: parentVortexId },
            ctx.importerId
          );
        }
      );

      nextCursor = pageInfo.endCursor ?? null;
      hasNextPage =
        pageInfo.hasNextPage && (limit === undefined || issueCount < limit);
      cursor = pageInfo.endCursor ?? undefined;
    }

    if (!nextCursor) {
      for (const rel of relationLinks.values()) {
        const toLocal =
          issueIdMap.get(rel.toExternalId) ??
          (await findImportMapping(ctx.db, ctx.jobId, rel.toExternalId))
            ?.vortexId;
        if (!toLocal) {
          continue;
        }
        try {
          await ctx.stub.createIssueRelation({
            fromIssueId: rel.fromIssueId,
            toIssueId: toLocal,
            type: rel.type,
          });
          relationCount++;
        } catch {
          // Skip invalid or malformed relation edges.
        }
      }
    }

    return {
      counts: {
        issues: issueCount,
        labels: newLabels,
        states: newStates,
        projects: newProjects,
        cycles: newCycles,
        users: newUsers,
        comments: commentCount,
        relations: relationCount,
        attachments: attachmentCount,
        history: historyCount,
        subscribers: subscriberCount,
        memberships: newMemberships,
        templates: newTemplates,
        parentLinks: parentLinkCount,
      },
      nextCursor,
    };
  },
};

interface LinearWorkspaceState {
  phase: "teams" | "issues";
  teamCursor?: string | null;
  teamIds?: string[];
  teamIndex?: number;
  vortexTeamId?: string;
  issueCursor?: string | null;
}

function encodeWorkspaceState(state: LinearWorkspaceState): string {
  return JSON.stringify(state);
}

function decodeWorkspaceState(cursor?: string): LinearWorkspaceState {
  if (!cursor) return { phase: "teams" };
  try {
    const parsed = JSON.parse(cursor) as LinearWorkspaceState;
    if (parsed.phase === "teams" || parsed.phase === "issues") return parsed;
    return { phase: "teams" };
  } catch {
    return { phase: "teams" };
  }
}

async function importLinearWorkspace(
  ctx: ImportContext,
  client: LinearClient,
  credentials: LinearCredentials,
  parsedOptions: LinearOptions,
  runState?: ImportRunState
): Promise<ImportBatchResult> {
  const state = decodeWorkspaceState(runState?.cursor ?? parsedOptions.cursor);

  if (state.phase === "teams") {
    const limit = runState?.limit ?? parsedOptions.limit;
    const first = limit ? Math.min(50, limit) : 50;
    const page = await client.getTeams(state.teamCursor ?? undefined, first);
    const teams = page.teams.nodes;
    const teamIds = [...(state.teamIds ?? []), ...teams.map((t) => t.id)];
    const hasNextPage = page.teams.pageInfo.hasNextPage;

    if (hasNextPage) {
      return {
        counts: { teams: teams.length },
        nextCursor: encodeWorkspaceState({
          phase: "teams",
          teamCursor: page.teams.pageInfo.endCursor ?? null,
          teamIds,
        }),
      };
    }

    return {
      counts: { teams: teamIds.length },
      nextCursor:
        teamIds.length > 0
          ? encodeWorkspaceState({
              phase: "issues",
              teamIds,
              teamIndex: 0,
              issueCursor: undefined,
            })
          : null,
    };
  }

  const teamIds = state.teamIds ?? [];
  const teamIndex = state.teamIndex ?? 0;
  if (teamIndex >= teamIds.length) {
    return { counts: {}, nextCursor: null };
  }

  const linearTeamId = teamIds[teamIndex];
  if (!linearTeamId) {
    return {
      counts: { errors: 1 },
      nextCursor: null,
    };
  }

  const linearTeam = await client.getTeam(linearTeamId);
  if (!linearTeam.team) {
    return {
      counts: { errors: 1 },
      nextCursor: null,
    };
  }

  const teamName = linearTeam.team.name ?? `Linear team ${teamIndex + 1}`;
  const teamKey = `${linearTeam.team.key ?? "LINEAR"}-${teamIndex + 1}`;
  const vortexTeam = state.vortexTeamId
    ? await getTeamById(ctx.db, state.vortexTeamId, ctx.organizationId)
    : await createTeam(ctx.db, {
        organizationId: ctx.organizationId,
        name: teamName,
        key: teamKey,
        ownerId: ctx.importerId,
      });
  if (!vortexTeam) {
    return {
      counts: { errors: 1 },
      nextCursor: null,
    };
  }

  const teamResult = await linearImportSource.run(
    ctx,
    credentials,
    {
      ...parsedOptions,
      workspace: undefined,
      linearTeamId,
      teamId: vortexTeam.id,
    },
    {
      cursor: state.issueCursor ?? undefined,
      limit: runState?.limit ?? parsedOptions.limit,
    }
  );

  const hasMoreIssues =
    teamResult.nextCursor !== undefined && teamResult.nextCursor !== null;
  const nextState: LinearWorkspaceState = hasMoreIssues
    ? {
        phase: "issues",
        teamIds,
        teamIndex,
        vortexTeamId: vortexTeam.id,
        issueCursor: teamResult.nextCursor,
      }
    : {
        phase: "issues",
        teamIds,
        teamIndex: teamIndex + 1,
        vortexTeamId: undefined,
        issueCursor: undefined,
      };

  return {
    counts: {
      ...teamResult.counts,
      teams: hasMoreIssues ? teamIndex + 1 : teamIndex + 1,
    },
    nextCursor:
      hasMoreIssues || nextState.teamIndex! < teamIds.length
        ? encodeWorkspaceState(nextState)
        : null,
  };
}
