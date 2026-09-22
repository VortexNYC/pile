import { z } from "zod";

const baseUrl = (process.env.PILE_BASE_URL ?? "https://pile.nyc").replace(
  /\/$/u,
  ""
);
const apiKey = process.env.PILE_API_KEY;
const workspace = process.argv.find(
  (arg, index) => arg === "--workspace" && index + 1 < process.argv.length
)
  ? process.argv[process.argv.indexOf("--workspace") + 1]
  : "org_vortex_main";
const apply = process.argv.includes("--apply");
const deleteDuplicates = process.argv.includes("--delete-duplicates");

if (!apiKey) {
  throw new Error("PILE_API_KEY is required");
}

const issueSchema = z
  .object({
    id: z.string(),
    identifier: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    teamId: z.string(),
    parentId: z.string().nullable(),
    externalRef: z.string().nullable(),
    projectId: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough();
type Issue = z.infer<typeof issueSchema>;

const issuePageSchema = z.object({
  issues: z.array(issueSchema),
  nextCursor: z.string().optional(),
});
const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    archivedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough();
const projectsResponseSchema = z.object({ projects: z.array(projectSchema) });

type Project = z.infer<typeof projectSchema>;
type Summary = {
  backfilled: number;
  duplicates: number;
  projects: number;
  failed: number;
};

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`
    );
  }
  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

async function listIssues(query: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let cursor: string | undefined;
  do {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = await request(
      `/workspaces/${encodeURIComponent(workspace)}/issues?limit=100${query}${suffix}`,
      issuePageSchema
    );
    issues.push(...page.issues);
    cursor = page.nextCursor;
  } while (cursor);
  return issues;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/^\[[a-z]+-\d+\]\s*/u, "")
    .replace(/\s+/gu, " ");
}

function canonicalIssue(issue: Issue): RegExpMatchArray | null {
  return (
    issue.description?.match(/Migrated from Linear\s+([A-Z]+-\d+)/u) ?? null
  );
}

function issueLabel(issue: Issue): string {
  return issue.identifier ?? issue.id;
}

async function main(): Promise<void> {
  const issues = await listIssues("");
  const canonicals = issues
    .map((issue) => ({ issue, match: canonicalIssue(issue) }))
    .filter(
      (entry): entry is { issue: Issue; match: RegExpMatchArray } =>
        entry.match !== null
    );
  const canonicalByTitle = new Map<string, Issue[]>();
  const backfills = canonicals.filter(({ issue }) => !issue.externalRef);
  for (const { issue } of canonicals) {
    const title = normalize(issue.title);
    const matches = canonicalByTitle.get(title) ?? [];
    matches.push(issue);
    canonicalByTitle.set(title, matches);
  }

  const duplicatePairs: Array<{ issue: Issue; canonical: Issue }> = [];
  for (const issue of issues) {
    if (
      canonicalIssue(issue) ||
      issue.status === "done" ||
      issue.status === "canceled"
    ) {
      continue;
    }
    const candidates = canonicalByTitle.get(normalize(issue.title));
    if (!candidates || candidates.length === 0) continue;
    const canonical =
      candidates.find((candidate) => candidate.teamId === issue.teamId) ??
      candidates[0];
    duplicatePairs.push({ issue, canonical });
  }

  const projectsResponse = await request(
    `/workspaces/${encodeURIComponent(workspace)}/projects`,
    projectsResponseSchema
  );
  const projectsByName = new Map<string, Project[]>();
  for (const project of projectsResponse.projects) {
    if (project.archivedAt) continue;
    const key = normalize(project.name);
    const group = projectsByName.get(key) ?? [];
    group.push(project);
    projectsByName.set(key, group);
  }
  const duplicateProjects = [...projectsByName.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => {
      const ordered = group.toSorted((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
      return ordered.slice(1).map((project) => ({
        project,
        keeper: ordered[0],
      }));
    });

  const summary: Summary = {
    backfilled: backfills.length,
    duplicates: duplicatePairs.length,
    projects: duplicateProjects.length,
    failed: 0,
  };
  console.log(
    `${apply ? "Applying" : "Dry run"}: ${backfills.length} externalRef backfills, ` +
      `${duplicatePairs.length} issue duplicates, ${duplicateProjects.length} project duplicates`
  );
  for (const { issue, match } of backfills) {
    console.log(`PATCH ${issueLabel(issue)} externalRef=linear:${match[1]}`);
  }
  for (const { issue, canonical } of duplicatePairs) {
    console.log(
      `${deleteDuplicates ? "DELETE" : "CANCEL"} ${issueLabel(issue)} ` +
        `"${issue.title}" -> dup of ${issueLabel(canonical)}`
    );
  }
  for (const { project, keeper } of duplicateProjects) {
    console.log(
      `MERGE PROJECT ${project.id} "${project.name}" -> ${keeper.id}`
    );
  }

  if (apply) {
    for (const { issue, match } of backfills) {
      try {
        await request(
          `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(issue.id)}`,
          z.unknown(),
          {
            method: "PATCH",
            body: JSON.stringify({ externalRef: `linear:${match[1]}` }),
          }
        );
      } catch (error) {
        summary.failed++;
        console.error(String(error));
      }
    }

    for (const { issue, canonical } of duplicatePairs) {
      try {
        const children = await listIssues(
          `&parentId=${encodeURIComponent(issue.id)}`
        );
        if (children.length > 0) {
          if (canonical.parentId === null) {
            for (const child of children) {
              await request(
                `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(child.id)}`,
                z.unknown(),
                {
                  method: "PATCH",
                  body: JSON.stringify({ parentId: canonical.id }),
                }
              );
            }
          } else {
            console.warn(
              `WARN ${issueLabel(issue)} children left in place because ${issueLabel(canonical)} has a parent`
            );
          }
        }
        await request(
          `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(issue.id)}/comments`,
          z.unknown(),
          {
            method: "POST",
            body: JSON.stringify({
              body: `Duplicate of ${issueLabel(canonical)} (consolidated from earlier import)`,
            }),
          }
        );
        if (deleteDuplicates) {
          await request(
            `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(issue.id)}`,
            z.unknown(),
            { method: "DELETE" }
          );
        } else {
          await request(
            `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(issue.id)}`,
            z.unknown(),
            {
              method: "PATCH",
              body: JSON.stringify({
                status: "canceled",
                resolution: "duplicate",
              }),
            }
          );
        }
        console.log(`OK ${issueLabel(issue)}`);
      } catch (error) {
        summary.failed++;
        console.error(`ERROR ${issueLabel(issue)}: ${String(error)}`);
      }
    }

    for (const { project, keeper } of duplicateProjects) {
      try {
        const projectIssues = await listIssues(
          `&projectId=${encodeURIComponent(project.id)}`
        );
        for (const issue of projectIssues) {
          await request(
            `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(issue.id)}`,
            z.unknown(),
            {
              method: "PATCH",
              body: JSON.stringify({ projectId: keeper.id }),
            }
          );
        }
        await request(
          `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project.id)}`,
          z.unknown(),
          { method: "DELETE" }
        );
        console.log(`OK project ${project.id}`);
      } catch (error) {
        summary.failed++;
        console.error(`ERROR project ${project.id}: ${String(error)}`);
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

await main();
