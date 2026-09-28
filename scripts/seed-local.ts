/**
 * Seed a local `wrangler dev` instance with a demo workspace.
 *
 * Usage:
 *   pnpm dev                 # in one shell
 *   pnpm run seed:local      # in another
 *
 * Idempotent-ish: safe to re-run; it always creates a fresh workspace.
 * Prints the API key it mints so you can use it with PILE_BASE_URL.
 */
const BASE_URL = process.env.PILE_BASE_URL ?? "http://127.0.0.1:8787";

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("origin")) headers.set("origin", BASE_URL);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`
    );
  }
  return res;
}

async function main() {
  const email = `demo-${Date.now()}@example.com`;

  // 1. Sign up (first signup becomes the workspace admin via onboard).
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: "demo-password-123",
      name: "Demo User",
    }),
  });
  const cookie = signup.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up returned no session cookie");

  // 2. Onboard a workspace — returns an admin API token.
  const onboard = (await (
    await api("/workspaces/onboard", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "Demo Co", slug: `demo-${Date.now()}` }),
    })
  ).json()) as {
    workspace: { id: string };
    team: { id: string; key: string };
    token: string;
  };

  const org = onboard.workspace.id;
  const auth = { authorization: `Bearer ${onboard.token}` };

  // 3. Demo issues across statuses.
  const issues = [
    { title: "Set up CI pipeline", status: "done", priority: "high" },
    {
      title: "Design public API surface",
      status: "in_progress",
      priority: "urgent",
    },
    { title: "Add webhook retries", status: "todo", priority: "medium" },
    { title: "Write onboarding docs", status: "backlog", priority: "low" },
  ] as const;
  for (const issue of issues) {
    await api(`/workspaces/${org}/issues`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...issue, teamId: onboard.team.id }),
    });
  }

  // 4. A support ticket with a vote, so the board/changelog surfaces have data.
  const customer = (await (
    await api(`/workspaces/${org}/support/customers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        email: "customer@example.com",
        fullName: "Demo Customer",
      }),
    })
  ).json()) as { customer: { id: string } };

  const ticket = (await (
    await api(`/workspaces/${org}/support/tickets`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customerId: customer.customer.id,
        title: "Dark mode support",
        sourceChannel: "chat",
        message: {
          textContent: "Would love a dark mode option in the dashboard.",
        },
      }),
    })
  ).json()) as { ticket: { id: string } };

  await api(`/workspaces/${org}/support/tickets/${ticket.ticket.id}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ isPublic: true }),
  });
  await api(`/workspaces/${org}/support/tickets/${ticket.ticket.id}/votes`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      email: "customer@example.com",
      priority: "important",
    }),
  });

  console.log(`Seeded workspace ${org} (team ${onboard.team.key})`);
  console.log(`API key: ${onboard.token}`);
  console.log(`Try: curl ${BASE_URL}/workspaces/${org}/board`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
