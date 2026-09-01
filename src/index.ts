export interface Env {
  DEVIN_TOKEN: string;
  LINEAR_WEBHOOK_SECRET: string;
  DEVIN_ORG_ID: string;
  DEVIN_OUTPOST: string;
  DAYTONA_LABEL_ID: string;
  LINEAR_DEVIN_USER_ID?: string;
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
  NOTION_VERIFICATION_TOKEN?: string;
  NOTION_TOKEN_PAGE_ID?: string;
  DEVIN_MODEL?: string;
}

interface LinearLabel {
  id: string;
  name: string;
}

interface LinearIssueData {
  id: string;
  identifier?: string;
  number?: number;
  title: string;
  description?: string;
  assignee?: { id: string } | null;
  assigneeId?: string | null;
  state?: { name: string };
  team?: { id: string; key?: string } | null;
  teamId?: string;
  labelIds?: string[];
  labels?: LinearLabel[] | { nodes: LinearLabel[] };
}

interface LinearIssuePayload {
  action: string;
  type: string;
  data: LinearIssueData;
  updatedFrom?: { labelIds?: string[] } | null;
  webhookTimestamp: number;
  [key: string]: unknown;
}

interface ExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void;
}

type NotionProp = Record<string, unknown> | undefined;

type QueueRecord = {
  name: string;
  description: string;
  repo: string;
  branch: string;
  model: string;
  platform: string;
  linear?: string;
  pr?: string;
  issueId?: string;
  started?: string;
  due?: string;
  slaHours?: number;
  requester?: string;
  customerRequest?: boolean;
  slaBreached?: boolean;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response("ok");
    }

    if (url.pathname.startsWith("/status/") && request.method === "GET") {
      return handleStatus(request, env);
    }

    if (url.pathname === "/notion-run" && request.method === "GET") {
      return handleNotionRunGet(request, env);
    }

    if (url.pathname === "/dispatch" && request.method === "POST") {
      return handleDispatch(request, env);
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/linear") {
      return handleLinearWebhook(request, env, ctx);
    }
    if (url.pathname === "/notion") {
      return handleNotionWebhook(request, env);
    }
    if (url.pathname === "/notion-webhook") {
      return handleNotionRealtimeWebhook(request, env);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await dispatchFromNotionQueue(env);
    await pollFromNotionQueue(env);
  },
};

export async function handleDispatch(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const repo = typeof body.repo === "string" ? body.repo : "";
  const description = typeof body.description === "string" ? body.description : "";
  const name = typeof body.name === "string" ? body.name : "devin-dispatch";
  const reference = typeof body.reference === "string" ? body.reference : crypto.randomUUID();

  if (!repo || !description) {
    return new Response("missing repo or description", { status: 400 });
  }

  const model = (typeof body.model === "string" ? body.model : env.DEVIN_MODEL || "swe-1-7-medium").toLowerCase();
  if (model.includes("lite") || model.includes("lightning")) {
    return new Response("forbidden model", { status: 400 });
  }

  const prompt = `# ${name}\n\n${description}`;

  try {
    const session = await createDevinSession({
      token: env.DEVIN_TOKEN,
      orgId: env.DEVIN_ORG_ID,
      platform: typeof body.platform === "string" ? body.platform : env.DEVIN_OUTPOST,
      model,
      title: name,
      prompt,
      pageId: reference,
    });
    return new Response(JSON.stringify({ id: session.id, url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("dispatch failed", { err });
    return new Response("failed to create session", { status: 500 });
  }
}

export async function handleStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.pathname.split("/").pop();
  if (!sessionId) {
    return new Response("missing session id", { status: 400 });
  }
  try {
    const session = await getDevinSession(sessionId, env.DEVIN_TOKEN, env.DEVIN_ORG_ID);
    return new Response(JSON.stringify(session), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("status check failed", { err });
    return new Response("failed to get session", { status: 500 });
  }
}

export async function handleLinearWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("linear-signature") || "";

  if (env.LINEAR_WEBHOOK_SECRET) {
    const expected = await hmacSha256Hex(env.LINEAR_WEBHOOK_SECRET, rawBody);
    if (!timingSafeEqualHex(signature, expected)) {
      return new Response("invalid signature", { status: 400 });
    }
  }

  let payload: LinearIssuePayload;
  try {
    payload = JSON.parse(rawBody) as LinearIssuePayload;
  } catch (e) {
    return new Response("invalid json", { status: 400 });
  }

  const event = request.headers.get("linear-event") || "";
  if (event !== "Issue") {
    return new Response("ignored event", { status: 200 });
  }

  if (payload.action !== "create" && payload.action !== "update") {
    return new Response("ignored action", { status: 200 });
  }

  const issue = payload.data;
  const identifier = issue?.identifier ?? (issue?.team?.key && issue?.number ? `${issue.team.key}-${issue.number}` : issue?.id);
  const hasDaytonaNow = hasDaytonaLabel(issue, env.DAYTONA_LABEL_ID);
  const hadDaytonaBefore = payload.updatedFrom?.labelIds
    ? payload.updatedFrom.labelIds.includes(env.DAYTONA_LABEL_ID)
    : true;

  console.log("linear webhook", {
    action: payload.action,
    identifier,
    hasDaytonaNow,
    hadDaytonaBefore,
    labelIds: issue?.labelIds,
    labels: issue?.labels,
  });

  const isNewWithLabel = payload.action === "create" && hasDaytonaNow;
  const isLabelJustAdded = hasDaytonaNow && !hadDaytonaBefore;

  if (!isNewWithLabel && !isLabelJustAdded) {
    return new Response("no daytona label change", { status: 200 });
  }

  const existing = await findDaytonaSession(identifier, env);
  if (existing) {
    return new Response("daytona session already exists", { status: 200 });
  }

  const isSmoke = issue.description?.toLowerCase().includes("smoke test") || false;
  const basePrompt = isSmoke
    ? `This is a smoke test. Read the ticket, execute exactly what it asks, and finish without opening a PR unless it explicitly requests one.`
    : `Work on this Linear ticket end-to-end. Read the title and description, explore the codebase, implement the requested change, run relevant tests, and open a pull request if code changes are needed.`;

  const prompt = `${basePrompt}\n\nTicket: ${identifier}\nTitle: ${issue.title}\n\nDescription:\n${issue.description || "(no description)"}`;

  const devinRes = await fetch(
    `https://api.devin.ai/v3/organizations/${env.DEVIN_ORG_ID}/sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DEVIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        platform: env.DEVIN_OUTPOST,
        model: "swe-1-7-medium",
        title: issue.title,
        tags: [`lin-ticket:${identifier}`, "linear-daytona"],
      }),
    }
  );

  if (!devinRes.ok) {
    const text = await devinRes.text();
    console.error("Devin session create failed:", devinRes.status, text);
    return new Response(`devin session create failed: ${devinRes.status}`, { status: 502 });
  }

  const session = (await devinRes.json()) as { session_id?: string; id?: string; url?: string };
  const sessionId = session.session_id ?? session.id;
  console.log("created devin session", { session_id: sessionId, url: session.url });

  const archivePromise = sleep(5000)
    .then(() => archiveConflictingSessions(identifier, sessionId ?? "", env))
    .catch((err) => console.error("archive conflicting sessions failed", err));

  if (payload.action === "create") {
    ctx.waitUntil(archivePromise);
  } else {
    await archivePromise;
  }

  return new Response("ok", { status: 200 });
}

export async function handleNotionWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { pageId?: string } | null;
  console.log("notion webhook received", body);
  await dispatchFromNotionQueue(env, body?.pageId);
  return new Response("ok", { status: 200 });
}

export async function handleNotionRunGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pageId = url.searchParams.get("pageId") || "";
  if (!pageId) {
    return new Response("missing pageId", { status: 400 });
  }
  console.log("notion manual run trigger", { pageId });
  await dispatchFromNotionQueue(env, pageId);
  return new Response("ok", { status: 200 });
}

interface NotionWebhookPayload {
  verification_token?: string;
  type?: string;
  entity?: { id: string; type: string };
  data?: Record<string, unknown>;
}

export async function handleNotionRealtimeWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  let payload: NotionWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as NotionWebhookPayload;
  } catch (e) {
    return new Response("invalid json", { status: 400 });
  }

  // Verification handshake — no signature header, just a verification_token
  if (typeof payload.verification_token === "string") {
    console.log("notion webhook verification_token received", payload.verification_token.slice(0, 8) + "...");
    if (env.NOTION_TOKEN_PAGE_ID) {
      await updateNotionPage(env.NOTION_TOKEN_PAGE_ID, env.NOTION_TOKEN, {
        Description: { rich_text: [{ text: { content: payload.verification_token } }] },
      }).catch((err) => console.error("failed to stash token in Notion page", err));
    }
    return new Response("ok", { status: 200 });
  }

  const signature = request.headers.get("x-notion-signature") || "";
  if (env.NOTION_VERIFICATION_TOKEN && signature) {
    const expected = `sha256=${await hmacSha256Hex(env.NOTION_VERIFICATION_TOKEN, rawBody)}`;
    if (!timingSafeEqualHex(signature, expected)) {
      console.error("notion webhook signature mismatch");
      return new Response("invalid signature", { status: 401 });
    }
  }

  console.log("notion webhook event", { type: payload.type, entity: payload.entity });

  const eventType = payload.type || "";
  const entity = payload.entity;

  if (!entity || entity.type !== "page") {
    return new Response("ok", { status: 200 });
  }

  if (eventType !== "page.properties_updated" && eventType !== "page.created") {
    return new Response("ok", { status: 200 });
  }

  const pageId = entity.id;
  try {
    const page = await getNotionPage(pageId, env.NOTION_TOKEN);
    const props = (page.properties as Record<string, NotionProp>) || {};
    const status = extractSelect(props["Status"]);
    const devinSession = extractUrl(props["Devin Session"]);
    const devinChecked = extractCheckbox(props["Devin"]);

    if (devinSession) {
      console.log("notion webhook skipping page, session exists", { pageId, status, has_session: true });
      return new Response("ok", { status: 200 });
    }

    if (status === "Ready") {
      await dispatchNotionRow(pageId, env);
      return new Response("ok", { status: 200 });
    }

    if (devinChecked && (status === "Backlog" || status === "Archived" || status === "Failed")) {
      console.log("notion webhook: Devin checked, promoting to Ready", { pageId, status });
      await updateNotionPage(pageId, env.NOTION_TOKEN, {
        Status: { select: { name: "Ready" } },
      });
      return new Response("ok", { status: 200 });
    }

    console.log("notion webhook skipping page", { pageId, status, devin: devinChecked });
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("notion webhook dispatch failed", { pageId, err });
    return new Response("dispatch failed", { status: 502 });
  }
}

export async function dispatchFromNotionQueue(env: Env, singlePageId?: string): Promise<void> {
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
    throw new Error("NOTION_TOKEN or NOTION_DATA_SOURCE_ID not configured");
  }

  const rows = await queryNotionQueue(env.NOTION_DATA_SOURCE_ID, env.NOTION_TOKEN, singlePageId);

  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    await dispatchNotionRow(row.id as string, env);
  }
}

export async function pollFromNotionQueue(env: Env): Promise<void> {
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
    throw new Error("NOTION_TOKEN or NOTION_DATA_SOURCE_ID not configured");
  }

  const rows = await queryNotionQueue(
    env.NOTION_DATA_SOURCE_ID,
    env.NOTION_TOKEN,
    undefined,
    "Running"
  );

  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    await pollNotionRow(row.id as string, env);
  }
}

export function checkSlaBreach(data: QueueRecord): boolean {
  if (!data.slaHours || !data.started) return false;
  const started = new Date(data.started).getTime();
  if (Number.isNaN(started)) return false;
  const deadline = started + data.slaHours * 60 * 60 * 1000;
  return Date.now() > deadline;
}

export async function pollNotionRow(pageId: string, env: Env): Promise<void> {
  const page = await getNotionPage(pageId, env.NOTION_TOKEN);
  const props = (page.properties as Record<string, NotionProp>) || {};
  const sessionUrl = extractUrl(props["Devin Session"]);
  if (!sessionUrl) {
    console.log("no Devin Session URL, skipping poll", { pageId });
    return;
  }

  const sessionId = parseSessionIdFromUrl(sessionUrl);
  if (!sessionId) {
    console.error("cannot parse session id from URL", { pageId, sessionUrl });
    return;
  }

  const data = parseQueuePage(page);

  try {
    if (checkSlaBreach(data) && !data.slaBreached) {
      await updateNotionPage(pageId, env.NOTION_TOKEN, { "SLA Breached": { checkbox: true } });
      await postNotionComment(pageId, env.NOTION_TOKEN, `SLA breached for ${data.name}`).catch(() => {});
      await addActivityBlock(pageId, env.NOTION_TOKEN, `SLA breached — ${new Date().toISOString()}`).catch(() => {});
    }

    const session = await getDevinSession(sessionId, env.DEVIN_TOKEN, env.DEVIN_ORG_ID);
    const terminal = sessionIsTerminal(session);
    if (!terminal) {
      console.log("session still running", { pageId, session_id: sessionId, status_detail: session.status_detail });
      return;
    }

    const newStatus = session.status === "failed" || session.status_detail === "error" || session.status_detail === "failed"
      ? "Failed"
      : "Done";

    const firstPr = session.pull_requests?.[0];
    const prUrl = firstPr?.url ?? firstPr?.pr_url;

    const now = new Date().toISOString();
    await updateNotionPage(pageId, env.NOTION_TOKEN, {
      Status: { select: { name: newStatus } },
      Completed: { date: { start: now } },
      ...(prUrl ? { PR: { url: prUrl } } : {}),
    });

    await postNotionComment(pageId, env.NOTION_TOKEN, `Devin session ${newStatus.toLowerCase()}: ${sessionUrl}`).catch(() => {});

    const resultBlocks = [
      { heading_2: { rich_text: [{ type: "text", text: { content: "Devin Result" } }] } },
      {
        paragraph: {
          rich_text: [
            { type: "text", text: { content: `Status: ${newStatus}` } },
          ],
        },
      },
      {
        paragraph: {
          rich_text: [
            { type: "text", text: { content: "Devin Session: " } },
            { type: "text", text: { content: sessionUrl, link: { url: sessionUrl } } },
          ],
        },
      },
      ...(prUrl
        ? [
            {
              paragraph: {
                rich_text: [
                  { type: "text", text: { content: "PR: " } },
                  { type: "text", text: { content: prUrl, link: { url: prUrl } } },
                ],
              },
            },
          ]
        : []),
    ];

    await appendNotionPageBlocks(pageId, env.NOTION_TOKEN, resultBlocks).catch((err) =>
      console.error("failed to append Devin result blocks", { pageId, err })
    );

    console.log("updated Notion row from Devin session", { pageId, session_id: sessionId, status: newStatus, pr_url: prUrl });
  } catch (err) {
    console.error("failed to poll Devin session for Notion row", { pageId, session_id: sessionId, err });
  }
}

export function parseSessionIdFromUrl(sessionUrl: string): string | undefined {
  const match = sessionUrl.match(/sessions\/([a-f0-9-]+)(?:\/|$)/);
  return match?.[1];
}

export async function getDevinSession(
  sessionId: string,
  token: string,
  orgId: string
): Promise<{
  session_id: string;
  status: string;
  status_detail: string | null;
  is_archived: boolean;
  pull_requests?: Array<{ url?: string; pr_url?: string; pr_state?: string }>;
}> {
  const res = await fetch(`https://api.devin.ai/v3/organizations/${orgId}/sessions/${sessionId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Devin session get failed: ${res.status} ${text}`);
  }
  return (await res.json()) as {
    session_id: string;
    status: string;
    status_detail: string | null;
    is_archived: boolean;
    pull_requests?: Array<{ url?: string; pr_url?: string; pr_state?: string }>;
  };
}

export function sessionIsTerminal(session: {
  status: string;
  status_detail: string | null;
  is_archived: boolean;
}): boolean {
  if (session.is_archived) return true;
  if (["completed", "done", "failed", "cancelled", "exit", "error", "suspended"].includes(session.status)) return true;
  if (["completed", "error", "failed", "cancelled", "timeout", "exit"].includes(session.status_detail || "")) return true;
  return false;
}

export async function queryNotionQueue(dataSourceId: string, token: string, singlePageId?: string, status?: string): Promise<Array<{ id: string }>> {
  const path = `https://api.notion.com/v1/data_sources/${dataSourceId}/query`;
  const body: Record<string, unknown> = { page_size: 100 };
  if (!singlePageId) {
    body.filter = { property: "Status", select: { equals: status || "Ready" } };
    body.sorts = [{ property: "Priority", direction: "descending" }];
  }

  const res = await fetch(path, {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion data source query failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { results?: Array<{ id: string }> };
  const rows = data.results || [];

  if (singlePageId) {
    return rows.filter((r) => r.id === singlePageId);
  }
  return rows;
}

export function generateBranchName(issueId: string | undefined, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return issueId ? `${issueId.toLowerCase()}-${slug}` : `vor-${slug || "fix"}`;
}

export async function dispatchNotionRow(pageId: string, env: Env): Promise<void> {
  const page = await getNotionPage(pageId, env.NOTION_TOKEN);
  const data = parseQueuePage(page);

  if (data.platform !== "user:daytona-linux") {
    console.log("skipping page, platform is not daytona-linux", { pageId, platform: data.platform });
    return;
  }

  const model = data.model || env.DEVIN_MODEL || "swe-1-7-medium";
  if (model.toLowerCase().includes("lite") || model.toLowerCase().includes("lightning")) {
    console.error("forbidden model requested", { pageId, model });
    await updateNotionPage(pageId, env.NOTION_TOKEN, {
      Status: { select: { name: "Ready" } },
    });
    return;
  }

  if (!data.repo || !data.description) {
    console.error("missing required repo or description", { pageId, repo: data.repo, description: data.description });
    return;
  }

  data.branch = data.branch || generateBranchName(data.issueId, data.name);
  const now = new Date().toISOString();

  await updateNotionPage(pageId, env.NOTION_TOKEN, {
    Status: { select: { name: "Running" } },
    Branch: { rich_text: [{ text: { content: data.branch } }] },
    Started: { date: { start: now } },
  });

  const prompt = buildNotionPrompt(pageId, data);

  const existing = await findNotionSession(pageId, env);
  if (existing) {
    console.log("notion session already exists for page", { pageId, existing_url: existing.url });
    await updateNotionPage(pageId, env.NOTION_TOKEN, {
      Status: { select: { name: "Running" } },
      "Devin Session": { url: existing.url },
    });
    await addActivityBlock(pageId, env.NOTION_TOKEN, `Reused existing Devin session — ${existing.url}`).catch(() => {});
    return;
  }

  try {
    const session = await createDevinSession({
      token: env.DEVIN_TOKEN,
      orgId: env.DEVIN_ORG_ID,
      platform: data.platform,
      model,
      title: data.name,
      prompt,
      pageId,
    });

    await updateNotionPage(pageId, env.NOTION_TOKEN, {
      Status: { select: { name: "Running" } },
      "Devin Session": { url: session.url },
    });

    await postNotionComment(pageId, env.NOTION_TOKEN, `Devin session started: ${session.url}`).catch(() => {});
    await addActivityBlock(pageId, env.NOTION_TOKEN, `Dispatched to Devin — ${session.url}`).catch(() => {});

    console.log("created Devin session for Notion page", { pageId, session_id: session.id, url: session.url });
  } catch (err) {
    console.error("failed to create Devin session for Notion page", { pageId, err });
    await updateNotionPage(pageId, env.NOTION_TOKEN, {
      Status: { select: { name: "Ready" } },
    });
  }
}

export function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2026-03-11",
    "Content-Type": "application/json",
  };
}

export async function getNotionPage(pageId: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: notionHeaders(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion page get failed: ${res.status} ${text}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function updateNotionPage(pageId: string, token: string, properties: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion page update failed: ${res.status} ${text}`);
  }
}

export async function appendNotionPageBlocks(
  pageId: string,
  token: string,
  children: Array<Record<string, unknown>>
): Promise<void> {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ children, position: { type: "end" } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion append blocks failed: ${res.status} ${text}`);
  }
}

export async function postNotionComment(pageId: string, token: string, text: string): Promise<void> {
  const res = await fetch("https://api.notion.com/v1/comments", {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: text } }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("failed to post Notion comment", { pageId, text, status: res.status, err });
  }
}

export async function addActivityBlock(pageId: string, token: string, text: string): Promise<void> {
  await appendNotionPageBlocks(pageId, token, [
    {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: text } }],
        icon: { type: "emoji", emoji: "⚡" },
      },
    },
  ]);
}

export function parseQueuePage(page: Record<string, unknown>): QueueRecord {
  const props = (page.properties as Record<string, NotionProp>) || {};
  return {
    name: extractText(props.Name) || "Untitled",
    description: extractText(props.Description),
    repo: extractText(props.Repo),
    branch: extractText(props.Branch),
    model: extractSelect(props.Model) || "swe-1-7-medium",
    platform: extractSelect(props.Platform) || "user:daytona-linux",
    linear: extractUrl(props.Linear),
    pr: extractUrl(props.PR),
    issueId: extractUniqueId(props["Issue ID"]),
    started: extractDate(props.Started),
    due: extractDate(props.Due),
    slaHours: extractNumber(props["SLA (hours)"]),
    requester: extractEmail(props.Requester),
    customerRequest: extractCheckbox(props["Customer Request"]),
    slaBreached: extractCheckbox(props["SLA Breached"]),
  };
}

export function extractText(prop: NotionProp): string {
  if (!prop || typeof prop !== "object") return "";
  const p = prop as Record<string, unknown>;
  const type = p.type;
  if (type !== "title" && type !== "rich_text" && type !== "text") return "";
  const arr = p[type] as unknown[] | undefined;
  if (!Array.isArray(arr)) return "";
  return arr
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => (typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("");
}

export function extractSelect(prop: NotionProp): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as Record<string, unknown>;
  if (p.type !== "select") return undefined;
  const sel = p.select as Record<string, unknown> | undefined;
  return typeof sel?.name === "string" ? sel.name : undefined;
}

export function extractUrl(prop: NotionProp): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as Record<string, unknown>;
  if (p.type !== "url") return undefined;
  return typeof p.url === "string" ? p.url : undefined;
}

export function extractCheckbox(prop: NotionProp): boolean {
  if (!prop || typeof prop !== "object") return false;
  const p = prop as Record<string, unknown>;
  if (p.type !== "checkbox") return false;
  return p.checkbox === true;
}

export function extractUniqueId(prop: NotionProp): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as Record<string, unknown>;
  if (p.type !== "unique_id") return undefined;
  const uid = p.unique_id as Record<string, unknown> | undefined;
  return typeof uid?.plain_text === "string" ? uid.plain_text : undefined;
}

export function extractDate(prop: NotionProp): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as Record<string, unknown>;
  if (p.type !== "date") return undefined;
  const d = p.date as Record<string, unknown> | undefined;
  return typeof d?.start === "string" ? d.start : undefined;
}

export function extractNumber(prop: NotionProp): number | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as Record<string, unknown>;
  if (p.type !== "number") return undefined;
  return typeof p.number === "number" ? p.number : undefined;
}

export function extractEmail(prop: NotionProp): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as Record<string, unknown>;
  if (p.type !== "email") return undefined;
  return typeof p.email === "string" ? p.email : undefined;
}

export function buildNotionPrompt(pageId: string, data: QueueRecord): string {
  const parts: string[] = [`# ${data.name}`];
  if (data.description) parts.push(data.description);
  if (data.repo) parts.push(`Repository: ${data.repo}`);
  if (data.branch) parts.push(`Branch: ${data.branch}`);
  if (data.linear) parts.push(`Linear reference: ${data.linear}`);
  if (data.pr) parts.push(`Existing PR: ${data.pr}`);
  if (data.customerRequest && data.requester) parts.push(`Customer request from: ${data.requester}`);
  if (data.customerRequest && !data.requester) parts.push(`Customer request`);
  parts.push(
    "\nWork through this task end-to-end. Explore the codebase, implement the requested change, run relevant tests, and open a pull request if code changes are needed.",
  );
  parts.push(
    "Do not attempt to update the Notion page yourself — an external system will poll your session and write the PR URL and final status back automatically. When you are done, simply finish with a short summary and the PR URL (or say 'no PR needed').",
  );
  return parts.join("\n\n");
}

export async function createDevinSession(args: {
  token: string;
  orgId: string;
  platform: string;
  model: string;
  title: string;
  prompt: string;
  pageId: string;
}): Promise<{ id: string; url: string }> {
  const res = await fetch(`https://api.devin.ai/v3/organizations/${args.orgId}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: args.prompt,
      platform: args.platform,
      model: args.model,
      title: args.title,
      tags: [`notion-task:${args.pageId}`, "notion-daytona"],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Devin session create failed: ${res.status} ${text}`);
  }

  const body = (await res.json()) as { session_id?: string; id?: string; url?: string };
  const id = body.session_id ?? body.id;
  if (!id) throw new Error("Devin response missing session id");
  return { id, url: body.url ?? `https://app.devin.ai/sessions/${id}` };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function archiveConflictingSessions(identifier: string, keepSessionId: string, env: Env): Promise<void> {
  const res = await fetch(
    `https://api.devin.ai/v3/organizations/${env.DEVIN_ORG_ID}/sessions?first=20&search=${encodeURIComponent(identifier)}`,
    {
      headers: {
        Authorization: `Bearer ${env.DEVIN_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    console.error("failed to list sessions for archive", res.status, await res.text());
    return;
  }

  const data = (await res.json()) as { items?: unknown[] };
  const items = (data.items || []) as Array<{
    session_id: string;
    origin: string;
    is_archived?: boolean;
    tags?: string[];
  }>;

  const conflicting = items.filter(
    (s) =>
      s.session_id !== keepSessionId &&
      !s.is_archived &&
      s.origin === "linear" &&
      s.tags?.includes(`lin-ticket:${identifier}`) &&
      !s.tags?.includes("linear-daytona")
  );

  for (const s of conflicting) {
    const archiveRes = await fetch(
      `https://api.devin.ai/v3/organizations/${env.DEVIN_ORG_ID}/sessions/devin-${s.session_id}?archive=true`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${env.DEVIN_TOKEN}`,
        },
      }
    );

    if (archiveRes.ok) {
      console.log("archived conflicting session", s.session_id);
    } else {
      console.error("failed to archive session", s.session_id, archiveRes.status, await archiveRes.text());
    }
  }
}

export function hasDaytonaLabel(issue: LinearIssueData, labelId: string): boolean {
  if (issue.labelIds && issue.labelIds.includes(labelId)) return true;

  const labels = issue.labels;
  if (!labels) return false;

  const arr = Array.isArray(labels) ? labels : labels.nodes;
  if (!arr) return false;

  return arr.some((l) => l.id === labelId || l.name?.toLowerCase() === "daytona");
}

export async function findNotionSession(pageId: string, env: Env): Promise<{ id: string; url: string } | undefined> {
  const res = await fetch(
    `https://api.devin.ai/v3/organizations/${env.DEVIN_ORG_ID}/sessions?first=20&search=${encodeURIComponent(pageId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.DEVIN_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    return undefined;
  }

  const data = (await res.json()) as { items?: unknown[] };
  const items = (data.items || []) as Array<{ session_id: string; url: string; tags?: string[]; is_archived?: boolean }>;
  const match = items.find(
    (s) => !s.is_archived && s.tags?.includes(`notion-task:${pageId}`) && s.tags?.includes("notion-daytona")
  );
  return match ? { id: match.session_id, url: match.url } : undefined;
}

export async function findDaytonaSession(identifier: string, env: Env): Promise<boolean> {
  const res = await fetch(
    `https://api.devin.ai/v3/organizations/${env.DEVIN_ORG_ID}/sessions?first=20&search=${encodeURIComponent(identifier)}`,
    {
      headers: {
        Authorization: `Bearer ${env.DEVIN_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    return false;
  }

  const data = (await res.json()) as { items?: unknown[] };
  const items = (data.items || []) as Array<{ tags?: string[]; is_archived?: boolean }>;
  return items.some(
    (s) => !s.is_archived && s.tags?.includes(`lin-ticket:${identifier}`) && s.tags?.includes("linear-daytona")
  );
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
