#!/usr/bin/env -S tsx
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const specPath = resolve(repoRoot, "src/mcp/openapi.json");
const outputPath = resolve(repoRoot, "packages/cli/src/commands.ts");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const EXCLUDED = new Set([
  "/github",
  "/health",
  "/workspaces/{organizationId}/ws",
  "/openapi.json",
  "/webhooks/agent/{organizationId}/{agentId}",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kebab(name: string): string {
  const special: Record<string, string> = {
    organizationId: "workspace",
    issueId: "issue",
    commentId: "comment",
    teamId: "team",
    memberId: "member",
    relationId: "relation",
    subscriberId: "subscriber",
    subscriptionId: "subscription",
    installationId: "installation",
    sessionId: "session",
    approvalId: "approval",
    linearId: "linear",
    notificationId: "notification",
    reactionId: "reaction",
    roadmapId: "roadmap",
    initiativeId: "initiative",
    templateId: "template",
    stateId: "state",
    labelId: "label",
    projectId: "project",
    cycleId: "cycle",
    tokenId: "token",
    userId: "user",
    attachmentId: "attachment",
    activityId: "activity",
    key: "key",
    identifier: "identifier",
    parentId: "parent",
    assigneeId: "assignee",
    labelIds: "label-ids",
    approverId: "approver",
    targetType: "target-type",
    targetId: "target",
    githubId: "github-id",
    prUrl: "pr-url",
    actorId: "actor",
    actorType: "actor-type",
    fileName: "file-name",
    fileSize: "file-size",
    mimeType: "mime-type",
    r2Key: "r2-key",
    createdAt: "created-at",
    updatedAt: "updated-at",
    startDate: "start-date",
    endDate: "end-date",
    isPublic: "is-public",
    parentAutoClose: "parent-auto-close",
    subIssueAutoClose: "sub-issue-auto-close",
    memberType: "member-type",
    relatedIssueId: "related",
    linearToken: "linear-token",
    templateData: "template-data",
    includeAll: "include-all",
  };
  return (
    special[name] ?? name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
  );
}

function commandName(method: string, path: string): string {
  if (path === "/workspaces")
    return method === "get" ? "workspaces list" : "workspaces create";
  if (path === "/workspaces/{id}")
    return method === "get"
      ? "workspaces get"
      : method === "patch"
        ? "workspaces update"
        : "workspaces delete";
  if (path === "/workspaces/slug/{slug}") return "workspaces slug";
  if (path === "/health") return "health";
  if (path === "/workspaces/{organizationId}/export") return "export";
  if (path === "/workspaces/{organizationId}/readiness") return "readiness";
  if (path === "/workspaces/{organizationId}/migrate/linear")
    return "migrate linear";
  if (path === "/workspaces/{organizationId}/github/install")
    return "github install";
  if (path === "/workspaces/{organizationId}/ws") return "ws";

  const scoped = path.replace(/^\/workspaces\/\{organizationId\}\//u, "");
  const segments = scoped.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  const isItem = last?.startsWith("{") ?? false;

  const resourceParts = segments
    .filter((s) => !s.startsWith("{"))
    .map((s) => s.replace(/-/g, " "));

  const action =
    method === "get"
      ? isItem
        ? "get"
        : "list"
      : method === "post"
        ? "create"
        : method === "patch" || method === "put"
          ? "update"
          : "delete";

  const customActions = new Set([
    "dispatch",
    "live",
    "activity",
    "history",
    "relations",
    "subscribers",
    "attachments",
    "approvals",
    "comments",
    "reactions",
    "members",
    "initiatives",
    "activities",
    "deliveries",
    "users",
    "installations",
    "unread-count",
    "read",
    "inverse",
    "batch",
    "respond",
    "slug",
  ]);

  if (
    !isItem &&
    resourceParts.length > 0 &&
    customActions.has(resourceParts[resourceParts.length - 1] ?? "")
  ) {
    return `${resourceParts.join(" ")}`;
  }

  return `${resourceParts.join(" ")} ${action}`.trim();
}

const specRaw: unknown = JSON.parse(readFileSync(specPath, "utf8"));
if (!isRecord(specRaw) || !isRecord(specRaw.paths)) {
  throw new Error("no paths in openapi.json");
}

interface CommandDef {
  method: string;
  path: string;
  params: { name: string; flag: string }[];
  query: { name: string; flag: string }[];
  body: { name: string; flag: string }[];
}

const commands: Record<string, CommandDef> = {};

for (const [path, methods] of Object.entries(specRaw.paths)) {
  if (!isRecord(methods) || EXCLUDED.has(path)) continue;
  for (const method of HTTP_METHODS) {
    const operation = methods[method];
    if (!isRecord(operation)) continue;

    const name = commandName(method, path);
    if (!name) continue;

    const params: { name: string; flag: string }[] = [];
    const query: { name: string; flag: string }[] = [];
    const parameters = Array.isArray(operation.parameters)
      ? operation.parameters
      : [];
    for (const p of parameters) {
      if (
        !isRecord(p) ||
        typeof p.name !== "string" ||
        typeof p.in !== "string"
      )
        continue;
      if (p.in === "path") params.push({ name: p.name, flag: kebab(p.name) });
      if (p.in === "query") query.push({ name: p.name, flag: kebab(p.name) });
    }

    const body: { name: string; flag: string }[] = [];
    const requestBody = isRecord(operation.requestBody)
      ? operation.requestBody
      : undefined;
    const content = isRecord(requestBody?.content)
      ? requestBody.content
      : undefined;
    const json = isRecord(content?.["application/json"])
      ? content["application/json"]
      : undefined;
    const schema = isRecord(json?.schema) ? json.schema : undefined;
    const properties = isRecord(schema?.properties) ? schema.properties : {};
    for (const key of Object.keys(properties)) {
      body.push({ name: key, flag: kebab(key) });
    }

    commands[name] = {
      method: method.toUpperCase(),
      path,
      params,
      query,
      body,
    };
  }
}

const commandsJson = JSON.stringify(commands, null, 2)
  .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, "$1:")
  .replace(/\n(\s*)([}\]])/g, ",\n$1$2");

const source = `// Generated by scripts/generate-cli.ts from src/mcp/openapi.json.
// Do not edit by hand: run \`pnpm run cli:generate\`.

export interface CommandDef {
  readonly method: string;
  readonly path: string;
  readonly params: readonly { name: string; flag: string }[];
  readonly query: readonly { name: string; flag: string }[];
  readonly body: readonly { name: string; flag: string }[];
}

export const COMMANDS: Record<string, CommandDef> = ${commandsJson};
`;

writeFileSync(outputPath, source);
console.log(
  JSON.stringify({
    ok: true,
    proof: "cli",
    commands: Object.keys(commands).length,
  })
);
