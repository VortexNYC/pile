import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  findOrCreateCustomerByEmail,
  updateCustomer as updateSupportCustomer,
} from "../global/support-contacts.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

// Field spec: the "Merchant Visit Intake Checklist" doc in the Sales space.
// Changes there change this app (PILE-326).

const contactSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  bestTime: z.string().optional(),
});

const intakeBodySchema = z.object({
  intakeId: z.string().min(1).optional(),
  businessName: z.string().min(1),
  address: z.string().optional(),
  websiteUrl: z.string().url().optional(),
  visitedAt: z.string().optional(),
  spokeWith: z
    .object({
      name: z.string().optional(),
      role: z.string().optional(),
      isDecisionMaker: z.boolean().optional(),
    })
    .optional(),
  owner: contactSchema.optional(),
  meeting: z
    .object({
      booked: z.boolean(),
      at: z.string().optional(),
      returnAt: z.string().optional(),
      bookingUrl: z.string().url().optional(),
    })
    .optional(),
  discovery: z
    .object({
      businessType: z.string().optional(),
      billingSystems: z.array(z.string()).optional(),
      paymentMethods: z.array(z.string()).optional(),
      hardware: z.string().optional(),
      hardwareOwnership: z.string().optional(),
      signage: z.string().optional(),
      fitNotes: z.string().optional(),
    })
    .optional(),
  pricing: z
    .object({
      currentProcessor: z.string().optional(),
      posSystem: z.string().optional(),
      underContract: z.boolean().optional(),
      contractEnd: z.string().optional(),
      earlyTerminationFee: z.string().optional(),
      timeWithProvider: z.string().optional(),
      monthlyCardVolume: z.string().optional(),
      averageTicket: z.string().optional(),
      transactionsPerDay: z.string().optional(),
      cardMix: z.string().optional(),
      channelMix: z.string().optional(),
      seasonality: z.string().optional(),
      monthlySalesTotals: z.string().optional(),
    })
    .optional(),
  pain: z
    .object({
      biggestComplaint: z.string().optional(),
      switchedBefore: z.string().optional(),
      wishes: z.string().optional(),
    })
    .optional(),
  pipelineStatusId: z.string().optional(),
  nextStep: z.string().optional(),
  nextStepDate: z.string().optional(),
  repNotes: z.string().optional(),
  statementFiles: z
    .array(
      z.object({
        key: z.string().min(1),
        url: z.string().min(1),
        name: z.string().optional(),
      })
    )
    .optional(),
});

type IntakeBody = z.infer<typeof intakeBodySchema>;

const intakeResultSchema = z.object({
  customerId: z.string(),
  contactId: z.string().nullable(),
  documentId: z.string().nullable(),
  statusId: z.string().nullable(),
  bookingLinkId: z.string().nullable(),
  deduped: z.boolean(),
});

function line(label: string, value: string | undefined | null): string | null {
  return value ? `- **${label}:** ${value}` : null;
}

function list(label: string, values: string[] | undefined): string | null {
  return values && values.length
    ? `- **${label}:** ${values.join(", ")}`
    : null;
}

function bool(label: string, value: boolean | undefined): string | null {
  return value === undefined ? null : `- **${label}:** ${value ? "yes" : "no"}`;
}

export function buildIntakeMarkdown(input: IntakeBody): string {
  const lines: (string | null)[] = [
    `# ${input.businessName} — visit intake`,
    "",
    "## Visit",
    line("Visited at", input.visitedAt),
    line("Address", input.address),
    line("Website", input.websiteUrl),
    line(
      "Spoke with",
      input.spokeWith?.name
        ? `${input.spokeWith.name}${input.spokeWith.role ? ` (${input.spokeWith.role})` : ""}${
            input.spokeWith.isDecisionMaker ? " — decision maker" : ""
          }`
        : undefined
    ),
    "",
    "## Owner contact",
    line("Name", input.owner?.name),
    line("Phone", input.owner?.phone),
    line("Email", input.owner?.email),
    line("Best time to reach", input.owner?.bestTime),
    "",
    "## Meeting",
    bool("Booked", input.meeting?.booked),
    line("When", input.meeting?.at),
    line("Return by", input.meeting?.returnAt),
    line("Booking link", input.meeting?.bookingUrl),
    "",
    "## Discovery",
    line("Business type", input.discovery?.businessType),
    list("Billing systems", input.discovery?.billingSystems),
    list("Payment methods", input.discovery?.paymentMethods),
    line(
      "Hardware",
      input.discovery?.hardware
        ? `${input.discovery.hardware}${
            input.discovery.hardwareOwnership
              ? ` (${input.discovery.hardwareOwnership})`
              : ""
          }`
        : input.discovery?.hardwareOwnership
    ),
    line("Fee signage", input.discovery?.signage),
    line("Fit notes", input.discovery?.fitNotes),
    "",
    "## Pricing",
    line("Current processor", input.pricing?.currentProcessor),
    line("POS / terminal", input.pricing?.posSystem),
    bool("Under contract", input.pricing?.underContract),
    line("Contract end", input.pricing?.contractEnd),
    line("Early termination fee", input.pricing?.earlyTerminationFee),
    line("Time with provider", input.pricing?.timeWithProvider),
    line("Monthly card volume", input.pricing?.monthlyCardVolume),
    line("Average ticket", input.pricing?.averageTicket),
    line("Transactions per day", input.pricing?.transactionsPerDay),
    line("Card mix", input.pricing?.cardMix),
    line("Channel mix", input.pricing?.channelMix),
    line("Seasonality", input.pricing?.seasonality),
    line(
      "Monthly sales totals (no statement)",
      input.pricing?.monthlySalesTotals
    ),
    "",
    "## Statements",
    ...(input.statementFiles?.length
      ? input.statementFiles.map(
          (f) =>
            `- [${f.name ?? f.key.split("/").pop() ?? "statement"}](${f.url})`
        )
      : ["- none captured"]),
    "",
    "## Pain",
    line("Biggest complaint", input.pain?.biggestComplaint),
    line("Switched before", input.pain?.switchedBefore),
    line("Wishes", input.pain?.wishes),
    "",
    "## Wrap",
    line(
      "Next step",
      input.nextStep
        ? `${input.nextStep}${input.nextStepDate ? ` — ${input.nextStepDate}` : ""}`
        : input.nextStepDate
    ),
    line("Rep notes", input.repNotes),
    line("Intake ref", input.intakeId),
    "",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

const intakeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/intake",
  tags: ["customers"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: intakeBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Intake already recorded (idempotent retry)",
      content: { "application/json": { schema: intakeResultSchema } },
    },
    201: {
      description: "Intake recorded",
      content: { "application/json": { schema: intakeResultSchema } },
    },
    400: { description: "Invalid request" },
  },
});

export function registerIntakeRoutes(app: OpenAPIHono<AppContext>) {
  app.get("/intake", (c) => c.html(INTAKE_PAGE));

  app.openapi(intakeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const db = createD1(c.env.D1);
    const intakeId = input.intakeId ?? crypto.randomUUID();

    if (input.pipelineStatusId) {
      const status = await stub.getCustomerStatus(input.pipelineStatusId);
      if (!status) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Unknown pipeline status",
        });
      }
    }

    // Statement files must point at this workspace's uploads — the /files read
    // route enforces the same prefix, so anything else is a dead link anyway.
    for (const file of input.statementFiles ?? []) {
      if (!file.key.startsWith(`${organizationId}/files/`)) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Statement file does not belong to this workspace",
        });
      }
    }

    // Customer — idempotent on intakeId so a retried submit after a mid-flow
    // failure (flaky cell connection) does not create a second merchant.
    let deduped = false;
    let customer = input.intakeId
      ? (await stub.listCustomers()).find(
          (existing) => existing.externalId === input.intakeId
        )
      : undefined;
    if (customer) {
      deduped = true;
      if (
        input.pipelineStatusId &&
        customer.statusId !== input.pipelineStatusId
      ) {
        customer = await stub.updateCustomer(
          customer.id,
          { statusId: input.pipelineStatusId },
          identity.id
        );
      }
    } else {
      customer = await stub.createCustomer({
        name: input.businessName,
        url: input.websiteUrl ?? null,
        externalId: intakeId,
        statusId: input.pipelineStatusId ?? null,
      });
    }

    // Owner contact — support contacts key on email, so a phone-only owner is
    // recorded in the intake document instead of minting a fake address.
    let contactId: string | null = null;
    if (input.owner?.email) {
      const contact = await findOrCreateCustomerByEmail(
        db,
        organizationId,
        input.owner.email,
        input.owner.name ?? null,
        "intake"
      );
      if (
        (input.owner.phone && !contact.phone) ||
        (input.owner.name && !contact.fullName)
      ) {
        await updateSupportCustomer(db, organizationId, contact.id, {
          phone: input.owner.phone,
          fullName: input.owner.name,
        });
      }
      contactId = contact.id;
    }

    // Cal.com booking link on the customer record — dedupe by URL so retries
    // don't stack identical links.
    let bookingLinkId: string | null = null;
    if (input.meeting?.bookingUrl) {
      const existing = await stub.listExternalLinks({
        entityType: "customer",
        entityId: customer.id,
      });
      const found = existing.find(
        (link) => link.url === input.meeting?.bookingUrl
      );
      bookingLinkId = found
        ? found.id
        : ((
            await stub.createExternalLink(
              {
                entityType: "customer",
                entityId: customer.id,
                url: input.meeting.bookingUrl,
                label: "Cal.com booking",
              },
              identity.id
            )
          )?.id ?? null);
    }

    // Intake document — slug makes the retry dedupe check cheap.
    const slug = `intake-${intakeId}`;
    let documentId: string | null = null;
    const existingDoc = (await stub.listDocuments({ slug }))[0];
    if (existingDoc) {
      documentId = existingDoc.id;
    } else {
      const doc = await stub.createDocument({
        title: `${input.businessName} — visit intake`,
        icon: "📋",
        content: buildIntakeMarkdown(input),
        contentFormat: "markdown",
        slug,
        createdById: identity.id,
      });
      documentId = doc.id;
    }

    const result = {
      customerId: customer.id,
      contactId,
      documentId,
      statusId: input.pipelineStatusId ?? customer.statusId ?? null,
      bookingLinkId,
      deduped,
    };
    return deduped ? c.json(result, 200) : c.json(result, 201);
  });
}

const INTAKE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pile — Merchant intake</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #0a0a0b; color: #e4e4e7; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 1rem 1rem 6rem; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  header { display: flex; align-items: baseline; gap: .75rem; padding: .75rem 0 1rem; }
  header select { margin-left: auto; max-width: 50%; }
  .muted { color: #71717a; font-size: .8rem; }
  a { color: #93c5fd; }
  fieldset { border: 1px solid #1f1f23; border-radius: 10px; padding: .9rem; margin-bottom: 1rem; background: #111113; }
  legend { font-size: .72rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: .08em; padding: 0 .4rem; }
  label { display: block; font-size: .8rem; color: #a1a1aa; margin: .7rem 0 .25rem; }
  label:first-of-type { margin-top: 0; }
  input, select, textarea {
    font: inherit; width: 100%; padding: .65rem .75rem; background: #18181b;
    color: #e4e4e7; border: 1px solid #27272a; border-radius: 8px;
  }
  input[type="checkbox"] { width: auto; margin-right: .5rem; }
  textarea { min-height: 4.5rem; resize: vertical; }
  .checks { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .3rem; }
  .chip { display: inline-flex; align-items: center; gap: .35rem; padding: .45rem .7rem; border: 1px solid #27272a; border-radius: 999px; font-size: .8rem; cursor: pointer; user-select: none; }
  .chip.on { background: #1e3a5f; border-color: #3b82f6; color: #bfdbfe; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
  button { font: inherit; padding: .65rem .9rem; border-radius: 8px; border: 1px solid #27272a; background: #18181b; color: #e4e4e7; cursor: pointer; }
  #submit { position: fixed; left: 0; right: 0; bottom: 0; padding: .8rem 1rem calc(.8rem + env(safe-area-inset-bottom)); background: #0a0a0bd9; backdrop-filter: blur(8px); border-top: 1px solid #1f1f23; }
  #submit button { width: 100%; max-width: 560px; margin: 0 auto; display: block; background: #2563eb; border: 0; font-weight: 600; font-size: 1rem; }
  #submit button:disabled { opacity: .5; }
  #status { font-size: .8rem; margin-top: .5rem; white-space: pre-wrap; }
  #status .err { color: #f87171; }
  #status .ok { color: #4ade80; }
  #done { margin-top: 1rem; }
  #done .card { border: 1px solid #14532d; background: #052e16; border-radius: 10px; padding: 1rem; }
  #auth { max-width: 340px; margin: 6rem auto 0; padding: 0 1rem; }
  #auth button { width: 100%; margin-top: .5rem; }
  .thumbs { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem; }
  .thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; border: 1px solid #27272a; }
  #stageSetup { margin-top: .4rem; font-size: .8rem; }
</style>
</head>
<body>
<div id="auth" hidden>
  <h1>Merchant intake</h1>
  <p class="muted" style="margin:.5rem 0 1rem">Sign in to log a visit.</p>
  <input id="email" type="email" placeholder="email" autocomplete="email" />
  <input id="pass" type="password" placeholder="password" autocomplete="current-password" style="margin-top:.5rem" />
  <button id="signin">Sign in</button>
  <p id="autherr" class="muted" style="color:#f87171;margin-top:.6rem"></p>
</div>
<main id="app" hidden>
  <header>
    <h1>Merchant intake</h1>
    <select id="ws" aria-label="Workspace"></select>
  </header>
  <form id="form" onsubmit="return false">
    <fieldset>
      <legend>Visit</legend>
      <label for="businessName">Business name *</label>
      <input id="businessName" required autocomplete="organization" />
      <label for="address">Address</label>
      <input id="address" autocomplete="street-address" />
      <div class="row2">
        <div><label for="spokeName">Spoke with</label><input id="spokeName" /></div>
        <div><label for="spokeRole">Their role</label><input id="spokeRole" placeholder="cashier, manager…" /></div>
      </div>
      <label class="chip" style="margin-top:.6rem"><input type="checkbox" id="isDm" /> Owner / decision maker</label>
    </fieldset>
    <fieldset>
      <legend>Owner contact</legend>
      <label for="ownerName">Owner name</label>
      <input id="ownerName" autocomplete="name" />
      <div class="row2">
        <div><label for="ownerPhone">Phone</label><input id="ownerPhone" type="tel" inputmode="tel" autocomplete="tel" /></div>
        <div><label for="ownerEmail">Email</label><input id="ownerEmail" type="email" inputmode="email" autocomplete="email" /></div>
      </div>
      <label for="bestTime">Best time to reach</label>
      <input id="bestTime" placeholder="mornings, after 3pm…" />
    </fieldset>
    <fieldset>
      <legend>Meeting</legend>
      <label class="chip"><input type="checkbox" id="booked" /> Meeting booked</label>
      <div id="meetWhen" style="display:none">
        <label for="meetAt">Date &amp; time</label>
        <input id="meetAt" type="datetime-local" />
      </div>
      <div id="retWhen">
        <label for="returnAt">If not booked — when to return</label>
        <input id="returnAt" placeholder="Tue morning, owner in after 5…" />
      </div>
      <label for="bookingUrl">Cal.com booking link</label>
      <input id="bookingUrl" type="url" inputmode="url" placeholder="https://cal.com/…" />
    </fieldset>
    <fieldset>
      <legend>Discovery</legend>
      <label for="bizType">What do they do to make money?</label>
      <select id="bizType">
        <option value="">—</option>
        <option>counter service</option><option>retail</option>
        <option>walk-in service</option><option>field service</option>
        <option>appointment</option><option>wholesale</option>
        <option>online-only</option><option>cash-only</option>
      </select>
      <label>How does money come in?</label>
      <div class="checks" id="billing"></div>
      <label>Payment methods</label>
      <div class="checks" id="payments"></div>
      <div class="row2">
        <div><label for="hardware">Hardware on the counter</label><input id="hardware" placeholder="Square terminal, Clover Duo…" /></div>
        <div><label for="hwOwn">Owned / leased / bundled</label>
          <select id="hwOwn"><option value="">—</option><option>owned</option><option>leased</option><option>bundled</option></select>
        </div>
      </div>
      <label for="signage">Surcharge / cash-discount signage</label>
      <input id="signage" placeholder="3% card fee sign at register…" />
      <label for="fit">Fit notes (flag regulated or unusual categories)</label>
      <textarea id="fit"></textarea>
    </fieldset>
    <fieldset>
      <legend>Pricing data</legend>
      <div class="row2">
        <div><label for="processor">Current processor</label><input id="processor" placeholder="Square, Clover, Worldpay…" /></div>
        <div><label for="pos">POS / terminal</label><input id="pos" /></div>
      </div>
      <label class="chip" style="margin-top:.6rem"><input type="checkbox" id="contract" /> Under contract</label>
      <div id="contractFields" style="display:none">
        <div class="row2">
          <div><label for="contractEnd">Contract end</label><input id="contractEnd" type="date" /></div>
          <div><label for="etf">Early termination fee</label><input id="etf" inputmode="decimal" placeholder="$" /></div>
        </div>
      </div>
      <label for="tenure">Time with current provider</label>
      <input id="tenure" placeholder="2 years…" />
      <label for="photos">Processing statement — photo every page (ask permission first)</label>
      <input id="photos" type="file" accept="image/*" capture="environment" multiple />
      <div class="thumbs" id="thumbs"></div>
      <div class="row2">
        <div><label for="volume">Monthly card volume</label><input id="volume" inputmode="decimal" placeholder="$" /></div>
        <div><label for="ticket">Average ticket</label><input id="ticket" inputmode="decimal" placeholder="$" /></div>
      </div>
      <div class="row2">
        <div><label for="tpd">Transactions / day</label><input id="tpd" inputmode="numeric" /></div>
        <div><label for="cardMix">Card mix</label>
          <select id="cardMix"><option value="">—</option>
            <option>mostly debit</option><option>mostly credit</option>
            <option>lots of rewards</option><option>business cards</option><option>mixed</option>
          </select>
        </div>
      </div>
      <label for="channelMix">In person vs keyed / online / invoiced</label>
      <select id="channelMix"><option value="">—</option>
        <option>mostly in-person tap/insert</option><option>meaningful keyed share</option>
        <option>meaningful online share</option><option>meaningful invoiced share</option><option>mixed</option>
      </select>
      <label for="season">Peak seasons / slow months</label>
      <input id="season" />
      <label for="salesTotals">No statement? Monthly card sales totals</label>
      <input id="salesTotals" placeholder="from their dashboard reports" />
    </fieldset>
    <fieldset>
      <legend>Pain &amp; motivation</legend>
      <label for="complaint">Biggest complaint, in their words</label>
      <textarea id="complaint" placeholder="fees, slow deposits, chargebacks, hardware, support…"></textarea>
      <label for="switched">Switched processors before? Why they left</label>
      <input id="switched" />
      <label for="wishes">Anything they wish the setup did</label>
      <input id="wishes" placeholder="faster funding, invoicing…" />
    </fieldset>
    <fieldset>
      <legend>Wrap</legend>
      <label for="stage">Pipeline stage</label>
      <select id="stage"></select>
      <div id="stageSetup" class="muted" hidden>No pipeline stages yet — <a href="#" id="mkStages">create the standard six</a>.</div>
      <div class="row2">
        <div><label for="nextStep">Next step</label><input id="nextStep" placeholder="the meeting, statement handoff…" /></div>
        <div><label for="nextDate">By when</label><input id="nextDate" type="date" /></div>
      </div>
      <label for="notes">Your notes — vibe, honesty check, real prospect?</label>
      <textarea id="notes"></textarea>
    </fieldset>
    <div id="status"></div>
    <div id="done"></div>
  </form>
</main>
<div id="submit" hidden><button id="go">Save intake</button></div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var api = function(p, o){ return fetch(p, { credentials: "same-origin", ...o }).then(function(r){
    if (!r.ok) return r.text().then(function(t){ throw new Error(r.status + " " + t); });
    return r.json();
  }); };
  var esc = function(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var val = function(id){ var v = $(id).value.trim(); return v || undefined; };
  var ws = localStorage.getItem("pile_ws") || "";
  var intakeId = crypto.randomUUID();

  var BILLING = ["point-of-sale","standalone terminal","invoicing software","online checkout","keyed phone orders","recurring billing","none"];
  var PAYMENTS = ["card-present","keyed","online","invoice links","recurring","bank transfer"];
  var STAGES = ["New","Meeting booked","Statement received","Proposal sent","Onboarded","Passed"];

  function chips(el, names){
    $(el).innerHTML = names.map(function(n){
      return '<label class="chip"><input type="checkbox" value="' + esc(n) + '" hidden />' + esc(n) + '</label>';
    }).join("");
    $(el).querySelectorAll(".chip").forEach(function(chip){
      chip.addEventListener("click", function(){ chip.classList.toggle("on"); });
    });
  }
  function chipValues(el){
    return Array.prototype.map.call($(el).querySelectorAll(".chip.on input"), function(i){ return i.value; });
  }
  chips("billing", BILLING);
  chips("payments", PAYMENTS);

  $("booked").addEventListener("change", function(e){
    $("meetWhen").style.display = e.target.checked ? "" : "none";
    $("retWhen").style.display = e.target.checked ? "none" : "";
  });
  $("contract").addEventListener("change", function(e){
    $("contractFields").style.display = e.target.checked ? "" : "none";
  });
  $("photos").addEventListener("change", function(e){
    $("thumbs").innerHTML = "";
    Array.prototype.forEach.call(e.target.files, function(f){
      var img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      $("thumbs").appendChild(img);
    });
  });

  async function boot(){
    var session = null;
    try { session = await api("/api/auth/get-session"); } catch (e) {}
    if (!session || !session.user) { $("auth").hidden = false; return; }
    var data = await api("/workspaces");
    if (!data.workspaces.length) { $("auth").hidden = false; $("autherr").textContent = "No workspace — sign in on a laptop first."; return; }
    $("app").hidden = false;
    $("submit").hidden = false;
    $("ws").innerHTML = data.workspaces.map(function(w){ return '<option value="' + esc(w.id) + '">' + esc(w.name) + "</option>"; }).join("");
    if (!data.workspaces.find(function(w){ return w.id === ws; })) ws = data.workspaces[0].id;
    $("ws").value = ws;
    await loadStages();
  }

  async function loadStages(){
    var res = await api("/workspaces/" + ws + "/customer-statuses");
    var list = res.statuses.slice().sort(function(a, b){ return a.position - b.position; });
    $("stage").innerHTML = '<option value="">—</option>' + list.map(function(s){
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>";
    }).join("");
    $("stageSetup").hidden = list.length > 0;
    var def = list.find(function(s){ return s.name === "New"; });
    if (def) $("stage").value = def.id;
  }

  $("mkStages").addEventListener("click", async function(e){
    e.preventDefault();
    for (var i = 0; i < STAGES.length; i++) {
      await api("/workspaces/" + ws + "/customer-statuses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: STAGES[i], position: i })
      });
    }
    await loadStages();
  });

  $("ws").addEventListener("change", function(e){
    ws = e.target.value;
    localStorage.setItem("pile_ws", ws);
    loadStages();
  });

  function say(msg, cls){ $("status").innerHTML = '<span class="' + (cls || "") + '">' + esc(msg) + "</span>"; }

  function fileToBase64(file){
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){ resolve(String(r.result).split(",")[1]); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function payload(statementFiles){
    var p = { intakeId: intakeId, businessName: val("businessName") };
    p.address = val("address");
    p.spokeWith = (val("spokeName") || val("spokeRole") || $("isDm").checked)
      ? { name: val("spokeName"), role: val("spokeRole"), isDecisionMaker: $("isDm").checked || undefined }
      : undefined;
    p.owner = (val("ownerName") || val("ownerPhone") || val("ownerEmail") || val("bestTime"))
      ? { name: val("ownerName"), phone: val("ownerPhone"), email: val("ownerEmail"), bestTime: val("bestTime") }
      : undefined;
    p.meeting = ($("booked").checked || val("returnAt") || val("bookingUrl"))
      ? { booked: $("booked").checked, at: val("meetAt"), returnAt: $("booked").checked ? undefined : val("returnAt"), bookingUrl: val("bookingUrl") }
      : undefined;
    p.discovery = {
      businessType: val("bizType"),
      billingSystems: chipValues("billing"),
      paymentMethods: chipValues("payments"),
      hardware: val("hardware"),
      hardwareOwnership: val("hwOwn"),
      signage: val("signage"),
      fitNotes: val("fit")
    };
    if (!Object.values(p.discovery).some(function(v){ return v && (Array.isArray(v) ? v.length : true); })) p.discovery = undefined;
    p.pricing = {
      currentProcessor: val("processor"), posSystem: val("pos"),
      underContract: $("contract").checked,
      contractEnd: $("contract").checked ? val("contractEnd") : undefined,
      earlyTerminationFee: $("contract").checked ? val("etf") : undefined,
      timeWithProvider: val("tenure"), monthlyCardVolume: val("volume"),
      averageTicket: val("ticket"), transactionsPerDay: val("tpd"),
      cardMix: val("cardMix"), channelMix: val("channelMix"),
      seasonality: val("season"), monthlySalesTotals: val("salesTotals")
    };
    p.pain = (val("complaint") || val("switched") || val("wishes"))
      ? { biggestComplaint: val("complaint"), switchedBefore: val("switched"), wishes: val("wishes") }
      : undefined;
    p.pipelineStatusId = val("stage");
    p.nextStep = val("nextStep");
    p.nextStepDate = val("nextDate");
    p.repNotes = val("notes");
    p.statementFiles = statementFiles;
    return p;
  }

  $("go").addEventListener("click", async function(){
    if (!val("businessName")) { say("Business name is required.", "err"); $("businessName").focus(); return; }
    var go = $("go");
    go.disabled = true;
    try {
      var files = Array.prototype.slice.call($("photos").files || []);
      var uploaded = [];
      for (var i = 0; i < files.length; i++) {
        say("Uploading statement photo " + (i + 1) + " of " + files.length + "…");
        var f = files[i];
        var up = await api("/workspaces/" + ws + "/files", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: f.name || ("statement-" + (i + 1) + ".jpg"), contentType: f.type || undefined, contentBase64: await fileToBase64(f) })
        });
        uploaded.push({ key: up.key, url: up.url, name: f.name });
      }
      say("Saving intake…");
      var result = await api("/workspaces/" + ws + "/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload(uploaded))
      });
      say("", "");
      $("done").innerHTML = '<div class="card"><b>' + esc(val("businessName")) + " logged</b>" +
        '<p class="muted" style="margin-top:.4rem">customer ' + esc(result.customerId.slice(0, 8)) +
        (result.documentId ? " · intake doc saved" : "") +
        (result.contactId ? " · owner contact saved" : "") +
        (result.bookingLinkId ? " · booking link attached" : "") +
        (result.deduped ? " · (already recorded)" : "") + "</p>" +
        '<button id="again" style="margin-top:.8rem;width:100%">New intake</button></div>';
      $("again").addEventListener("click", function(){
        $("form").reset();
        $("thumbs").innerHTML = "";
        document.querySelectorAll(".chip.on").forEach(function(c){ c.classList.remove("on"); });
        $("done").innerHTML = "";
        intakeId = crypto.randomUUID();
        scrollTo(0, 0);
      });
      $("done").scrollIntoView();
    } catch (e) {
      say("Save failed — your form is intact, tap Save again. (" + (e && e.message ? e.message : "network") + ")", "err");
    } finally {
      go.disabled = false;
    }
  });

  $("signin").addEventListener("click", async function(){
    $("autherr").textContent = "";
    try {
      await api("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("pass").value }) });
      location.reload();
    } catch (e) { $("autherr").textContent = "Sign in failed."; }
  });

  boot().catch(function(){ $("auth").hidden = false; });
})();
</script>
</body>
</html>`;
