import type { Hono } from "hono";

import type { WorkerEnv } from "../platform/middleware.js";

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pile</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #0a0a0b; color: #e4e4e7; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 960px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: .02em; }
  header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1.5rem; }
  header select { margin-left: auto; }
  .muted { color: #71717a; font-size: .8rem; }
  a { color: #93c5fd; text-decoration: none; }
  button, input, select { font: inherit; background: #18181b; color: #e4e4e7; border: 1px solid #27272a; border-radius: 6px; padding: .4rem .7rem; }
  button { cursor: pointer; }
  button:hover { border-color: #3f3f46; }
  input { width: 100%; margin-bottom: .6rem; }
  .card { background: #111113; border: 1px solid #1f1f23; border-radius: 8px; padding: 1rem; }
  #auth { max-width: 340px; margin: 6rem auto 0; }
  #auth h1 { margin-bottom: 1rem; }
  #auth button { width: 100%; margin-top: .4rem; }
  .row { display: flex; gap: .75rem; align-items: center; padding: .6rem .75rem; border: 1px solid #1f1f23; border-radius: 8px; margin-bottom: .5rem; cursor: pointer; }
  .row:hover { border-color: #3f3f46; }
  .row.blocked { border-color: #7f1d1d; background: #1a0d0d; }
  .badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; padding: .15rem .45rem; border-radius: 4px; white-space: nowrap; }
  .b-running { background: #052e16; color: #4ade80; }
  .b-created, .b-waiting { background: #422006; color: #fbbf24; }
  .b-failed { background: #450a0a; color: #f87171; }
  .b-completed { background: #1e293b; color: #94a3b8; }
  .b-canceled { background: #27272a; color: #71717a; }
  .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #detail { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: none; align-items: flex-start; justify-content: center; padding: 4rem 1rem; }
  #detail.open { display: flex; }
  #detail .panel { background: #111113; border: 1px solid #27272a; border-radius: 10px; width: 640px; max-height: 75vh; overflow: auto; padding: 1.25rem; }
  .event { padding: .35rem 0; border-bottom: 1px solid #1f1f23; font-size: .8rem; }
  .event:last-child { border-bottom: 0; }
  .indent { margin-left: 1.25rem; }
  .err { color: #f87171; }
  .section { margin-top: 1.75rem; }
  .section h2 { font-size: .8rem; color: #71717a; text-transform: uppercase; letter-spacing: .08em; margin-bottom: .6rem; }
  .cols { display: flex; gap: .75rem; overflow-x: auto; }
  .col { min-width: 210px; }
  .col h3 { font-size: .75rem; color: #a1a1aa; margin-bottom: .5rem; }
  .issue { font-size: .78rem; padding: .45rem .6rem; border: 1px solid #1f1f23; border-radius: 6px; margin-bottom: .4rem; }
  .needs { color: #f87171; font-weight: 600; }
</style>
</head>
<body>
<div id="auth" hidden>
  <h1>Pile</h1>
  <p class="muted" style="margin-bottom:1rem">Sign in to watch your agents.</p>
  <input id="email" type="email" placeholder="email" autocomplete="email" />
  <input id="pass" type="password" placeholder="password" autocomplete="current-password" />
  <button id="signin">Sign in</button>
  <p id="autherr" class="err muted" style="margin-top:.6rem"></p>
  <p class="muted" style="margin-top:.8rem"><a href="#" id="signup">Create an account</a></p>
</div>
<div id="onboard" hidden>
  <div class="card" style="max-width:340px;margin:6rem auto 0">
    <h1 style="margin-bottom:1rem">Create your workspace</h1>
    <input id="wsname" type="text" placeholder="workspace name" />
    <button id="mkws" style="width:100%">Create</button>
    <p id="wserr" class="err muted" style="margin-top:.6rem"></p>
  </div>
</div>
<main id="app" hidden>
  <header>
    <h1>Pile</h1>
    <span id="needs" class="needs"></span>
    <select id="ws"></select>
  </header>
  <div class="section">
    <h2>Agent sessions</h2>
    <div id="sessions"></div>
  </div>
  <div class="section">
    <h2>Issues</h2>
    <div id="board" class="cols"></div>
  </div>
</main>
<div id="detail"><div class="panel" id="panel"></div></div>
<script>
const $ = (id) => document.getElementById(id);
const api = (p, o) => fetch(p, { credentials: "same-origin", ...o }).then(async (r) => {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
});
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (t) => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? "now" : m < 60 ? m + "m" : Math.round(m / 60) + "h"; };
const dur = (a, b) => { const s = ((new Date(b) - new Date(a)) / 1000) | 0; return s < 60 ? s + "s" : Math.round(s / 60) + "m"; };

let ws = localStorage.getItem("pile_ws") || "";
let sessions = [];

async function boot() {
  let session = null;
  try { session = await api("/api/auth/get-session"); } catch {}
  if (!session || !session.user) { $("auth").hidden = false; return; }
  const { workspaces } = await api("/workspaces");
  if (!workspaces.length) { $("onboard").hidden = false; return; }
  $("app").hidden = false;
  $("ws").innerHTML = workspaces.map((w) => "<option value='" + esc(w.id) + "'>" + esc(w.name) + "</option>").join("");
  if (!workspaces.find((w) => w.id === ws)) ws = workspaces[0]?.id || "";
  $("ws").value = ws;
  await refresh();
  setInterval(refresh, 15000);
}

async function refresh() {
  if (!ws) return;
  try {
    const [{ sessions: s }, { issues }] = await Promise.all([
      api("/workspaces/" + ws + "/agent/sessions?limit=50"),
      api("/workspaces/" + ws + "/issues"),
    ]);
    sessions = s;
    const blocked = s.filter((x) => x.status === "failed" || x.status === "waiting").length;
    $("needs").textContent = blocked ? blocked + " need" + (blocked > 1 ? "s" : "") + " you" : "";
    renderSessions(s);
    renderBoard(issues);
  } catch (e) { console.error(e); }
}

function renderSessions(s) {
  $("sessions").innerHTML = s.length ? s.map((x) => {
    const blocked = x.status === "failed" || x.status === "waiting";
    return "<div class='row" + (blocked ? " blocked" : "") + "' data-id='" + esc(x.id) + "'>" +
      "<span class='badge b-" + esc(x.status) + "'>" + esc(x.status) + "</span>" +
      "<span class='grow'>" + esc(x.result || x.issueId || x.id) + "</span>" +
      "<span class='muted'>" + esc(x.provider) + (x.prUrl ? " · <a href='" + esc(x.prUrl) + "' onclick='event.stopPropagation()'>PR</a>" : "") + " · " + ago(x.updatedAt) + "</span></div>";
  }).join("") : "<p class='muted'>No agent sessions yet.</p>";
  document.querySelectorAll("#sessions .row").forEach((r) => r.addEventListener("click", () => openDetail(r.dataset.id)));
}

const COLS = ["triage", "backlog", "unstarted", "started", "done", "canceled"];
function renderBoard(issues) {
  $("board").innerHTML = COLS.map((c) => {
    const items = issues.filter((i) => i.status === c);
    if (!items.length) return "";
    return "<div class='col'><h3>" + c + " (" + items.length + ")</h3>" + items.map((i) =>
      "<div class='issue'><b>" + esc(i.identifier) + "</b> " + esc(i.title) + "</div>").join("") + "</div>";
  }).join("");
}

async function openDetail(id) {
  const x = sessions.find((s) => s.id === id);
  const { events } = await api("/workspaces/" + ws + "/agent/sessions/" + id + "/events");
  const kids = Object.fromEntries(events.map((e) => [e.id, []]));
  const roots = [];
  for (const e of events) (e.parentId && kids[e.parentId] ? kids[e.parentId] : roots).push(e);
  const node = (e) => "<div class='event" + (e.parentId ? " indent" : "") + "'>" +
    "<span class='muted'>" + ago(e.createdAt) + (e.endedAt ? " · " + dur(e.startedAt || e.createdAt, e.endedAt) : "") + "</span> " +
    "<b class='" + (e.type === "error" ? "err" : "") + "'>" + esc(e.type) + "</b> " + esc(e.message) +
    kids[e.id].map(node).join("") + "</div>";
  $("panel").innerHTML = "<div style='display:flex;align-items:baseline;gap:.75rem;margin-bottom:1rem'>" +
    "<span class='badge b-" + esc(x.status) + "'>" + esc(x.status) + "</span><h1>" + esc(x.provider) + " session</h1></div>" +
    (x.url ? "<p><a href='" + esc(x.url) + "'>provider session</a></p>" : "") +
    (x.prUrl ? "<p><a href='" + esc(x.prUrl) + "'>pull request</a></p>" : "") +
    (x.result ? "<p class='muted'>" + esc(x.result) + "</p>" : "") +
    "<div class='section'><h2>Timeline</h2>" + (roots.map(node).join("") || "<p class='muted'>No events.</p>") + "</div>" +
    "<p style='margin-top:1rem'><button onclick='document.getElementById(&quot;detail&quot;).classList.remove(&quot;open&quot;)'>Close</button></p>";
  $("detail").classList.add("open");
}

$("detail").addEventListener("click", (e) => { if (e.target.id === "detail") e.target.classList.remove("open"); });
$("ws").addEventListener("change", (e) => { ws = e.target.value; localStorage.setItem("pile_ws", ws); refresh(); });
$("signin").addEventListener("click", async () => {
  $("autherr").textContent = "";
  try {
    await api("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("pass").value }) });
    location.reload();
  } catch { $("autherr").textContent = "Sign in failed."; }
});
$("signup").addEventListener("click", async (e) => {
  e.preventDefault();
  $("autherr").textContent = "";
  try {
    await api("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("pass").value, name: $("email").value.split("@")[0] }) });
    location.reload();
  } catch { $("autherr").textContent = "Sign up failed."; }
});
$("mkws").addEventListener("click", async () => {
  $("wserr").textContent = "";
  const name = $("wsname").value.trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) { $("wserr").textContent = "Name required."; return; }
  try {
    await api("/workspaces/onboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug }) });
    location.reload();
  } catch (e) { $("wserr").textContent = "Could not create workspace."; }
});
boot();
</script>
</body>
</html>`;

export function registerAppRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get("/app", (c) => c.html(PAGE));
}
