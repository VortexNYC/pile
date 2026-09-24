/**
 * Pile support chat widget — the Intercom/Plain-style one-tag embed.
 *
 * <script src="https://pile.nyc/chat.js" data-pile-widget="wgt_…"></script>
 *
 * Attributes / window.pileChatSettings fields:
 *   widget (required) — the wgt_ publishable key
 *   endpoint — API origin (defaults to the script's origin)
 *   externalId, email, name, identifierHash — identity ladder
 *   greeting, brandColor, theme (light|dark|auto), hideLauncher
 *
 * window.PileChat(cmd, arg): 'open' | 'close' | 'toggle' | 'setUser' |
 * 'destroy'. If a stub queued calls on window.PileChat.q before the bundle
 * loaded, they are flushed after boot.
 */

type WidgetSettings = {
  widget?: string;
  endpoint?: string;
  externalId?: string;
  email?: string;
  name?: string;
  identifierHash?: string;
  greeting?: string;
  brandColor?: string;
  theme?: "light" | "dark" | "auto";
  hideLauncher?: boolean;
};

type PileChatFn = {
  (cmd: string, arg?: unknown): void;
  q?: unknown[];
};

type SessionResponse = {
  sessionToken: string;
  ticketId: string | null;
  config: {
    greeting: string | null;
    brandColor: string | null;
    requireEmail: boolean;
  };
};

type WidgetMessage = {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  createdAt: string;
};

const POLL_OPEN_MS = 4_000;
const POLL_CLOSED_MS = 20_000;

function readSettings(): WidgetSettings {
  const script = document.currentScript as HTMLScriptElement | null;
  const d = script?.dataset ?? {};
  const global =
    (globalThis as { pileChatSettings?: WidgetSettings }).pileChatSettings ??
    {};
  return {
    widget: global.widget ?? d.pileWidget,
    endpoint: global.endpoint ?? d.pileEndpoint,
    externalId: global.externalId ?? d.pileExternalId,
    email: global.email ?? d.pileEmail,
    name: global.name ?? d.pileName,
    identifierHash: global.identifierHash ?? d.pileIdentifierHash,
    greeting: global.greeting ?? d.pileGreeting,
    brandColor: global.brandColor ?? d.pileBrandColor,
    theme: global.theme ?? (d.pileTheme as WidgetSettings["theme"]),
    hideLauncher: global.hideLauncher ?? d.pileHideLauncher === "true",
  };
}

function boot(settings: WidgetSettings): void {
  if (!settings.widget) return;
  const script = document.currentScript as HTMLScriptElement | null;
  const endpoint =
    settings.endpoint ??
    (script?.src ? new URL(script.src).origin : window.location.origin);
  const key = settings.widget;
  const storageKey = `pile_chat:${key}`;

  let sessionToken = localStorage.getItem(storageKey) ?? undefined;
  let lastSeen = "";
  let open = false;
  let requireEmail = false;
  let email = settings.email;
  let name = settings.name;
  let pollTimer = 0;

  const host = document.createElement("div");
  host.id = "pile-chat";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  const dark =
    settings.theme === "dark" ||
    (settings.theme !== "light" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const brand = settings.brandColor ?? "#4f46e5";

  root.innerHTML = `
    <style>
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      .launcher { position: fixed; bottom: 20px; right: 20px; width: 52px; height: 52px; border-radius: 50%;
        background: ${brand}; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); z-index: 2147483000; }
      .launcher svg { width: 24px; height: 24px; fill: #fff; }
      .badge { position: absolute; top: -4px; right: -4px; background: #ef4444; color: #fff; border-radius: 999px;
        font-size: 11px; min-width: 18px; height: 18px; display: none; align-items: center; justify-content: center; padding: 0 5px; }
      .panel { position: fixed; bottom: 84px; right: 20px; width: 360px; max-width: calc(100vw - 40px); height: 480px;
        max-height: calc(100vh - 120px); border-radius: 14px; overflow: hidden; display: none; flex-direction: column;
        background: ${dark ? "#17181c" : "#fff"}; color: ${dark ? "#e7e7ea" : "#1a1a1e"};
        box-shadow: 0 8px 40px rgba(0,0,0,.3); z-index: 2147483000; border: 1px solid ${dark ? "#2a2b31" : "#e5e5ea"}; }
      .header { background: ${brand}; color: #fff; padding: 14px 16px; font-weight: 600; font-size: 14px; }
      .header small { display: block; font-weight: 400; opacity: .85; font-size: 12px; margin-top: 2px; }
      .msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
      .msg { max-width: 80%; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
      .in { align-self: flex-end; background: ${brand}; color: #fff; border-bottom-right-radius: 4px; }
      .out { align-self: flex-start; background: ${dark ? "#2a2b31" : "#f0f0f4"}; border-bottom-left-radius: 4px; }
      .greeting { align-self: flex-start; background: none; color: ${dark ? "#9a9aa2" : "#666"}; font-size: 13px; padding: 4px 0; }
      .composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid ${dark ? "#2a2b31" : "#e5e5ea"}; }
      .composer input { flex: 1; border: 1px solid ${dark ? "#3a3b42" : "#d5d5db"}; border-radius: 8px; padding: 8px 10px;
        font-size: 13px; background: ${dark ? "#1e1f24" : "#fff"}; color: inherit; }
      .composer button { background: ${brand}; color: #fff; border: none; border-radius: 8px; padding: 8px 14px;
        font-size: 13px; cursor: pointer; }
      .email-gate { padding: 10px; border-top: 1px solid ${dark ? "#2a2b31" : "#e5e5ea"}; display: none; gap: 8px; }
      .email-gate input { flex: 1; border: 1px solid ${dark ? "#3a3b42" : "#d5d5db"}; border-radius: 8px; padding: 8px 10px;
        font-size: 13px; background: ${dark ? "#1e1f24" : "#fff"}; color: inherit; }
    </style>
    <button class="launcher" aria-label="Chat with us">
      <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>
      <span class="badge"></span>
    </button>
    <div class="panel">
      <div class="header">Chat with us<small></small></div>
      <div class="msgs"></div>
      <div class="email-gate">
        <input class="email" type="email" placeholder="Your email" />
        <button class="save-email">Start</button>
      </div>
      <div class="composer">
        <input class="text" type="text" placeholder="Write a message…" />
        <button class="send">Send</button>
      </div>
    </div>`;

  const launcher = root.querySelector<HTMLButtonElement>(".launcher")!;
  const badge = root.querySelector<HTMLSpanElement>(".badge")!;
  const panel = root.querySelector<HTMLDivElement>(".panel")!;
  const msgs = root.querySelector<HTMLDivElement>(".msgs")!;
  const textInput = root.querySelector<HTMLInputElement>(".text")!;
  const sendBtn = root.querySelector<HTMLButtonElement>(".send")!;
  const emailGate = root.querySelector<HTMLDivElement>(".email-gate")!;
  const emailInput = root.querySelector<HTMLInputElement>(".email")!;
  const saveEmailBtn = root.querySelector<HTMLButtonElement>(".save-email")!;
  const headerSub = root.querySelector<HTMLElement>(".header small")!;

  if (settings.hideLauncher) launcher.style.display = "none";

  function addMsg(direction: "inbound" | "outbound", text: string): void {
    const div = document.createElement("div");
    div.className = `msg ${direction === "inbound" ? "in" : "out"}`;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setBadge(n: number): void {
    badge.style.display = n > 0 ? "flex" : "none";
    badge.textContent = String(n);
  }

  async function api(
    path: string,
    init?: RequestInit
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { "x-pile-widget-session": sessionToken } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) throw new Error(`pile-chat ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function startSession(): Promise<void> {
    const data = (await api(`/support/widget/${key}/session`, {
      method: "POST",
      body: JSON.stringify({
        sessionToken,
        externalId: settings.externalId,
        email,
        name,
        identifierHash: settings.identifierHash,
      }),
    })) as unknown as SessionResponse;
    sessionToken = data.sessionToken;
    localStorage.setItem(storageKey, sessionToken);
    requireEmail = data.config.requireEmail;
    if (data.config.greeting && msgs.childElementCount === 0) {
      const g = document.createElement("div");
      g.className = "greeting";
      g.textContent = data.config.greeting;
      msgs.prepend(g);
    }
    if (settings.brandColor === undefined && data.config.brandColor) {
      headerSub.parentElement!.style.background = data.config.brandColor;
    }
    if (requireEmail && !email) emailGate.style.display = "flex";
  }

  async function poll(): Promise<void> {
    if (!sessionToken) return;
    try {
      const data = (await api(
        `/support/widget/${key}/messages${lastSeen ? `?after=${encodeURIComponent(lastSeen)}` : ""}`
      )) as { messages: WidgetMessage[] };
      let unread = 0;
      for (const m of data.messages) {
        if (m.createdAt > lastSeen) {
          addMsg(m.direction, m.text);
          if (m.direction === "outbound" && !open) unread++;
          lastSeen = m.createdAt;
        }
      }
      if (unread > 0) setBadge(unread);
    } catch {
      // transient — next poll retries
    }
    pollTimer = window.setTimeout(poll, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
  }

  async function send(): Promise<void> {
    const text = textInput.value.trim();
    if (!text || !sessionToken) return;
    if (requireEmail && !email) {
      emailGate.style.display = "flex";
      emailInput.focus();
      return;
    }
    textInput.value = "";
    try {
      const sent = (await api(`/support/widget/${key}/messages`, {
        method: "POST",
        body: JSON.stringify({
          text,
          email,
          name,
          externalId: crypto.randomUUID(),
        }),
      })) as { createdAt?: string };
      addMsg("inbound", text);
      // Advance the poll cursor past the message we just rendered so the next
      // poll doesn't fetch (and re-render) our own send.
      if (sent.createdAt && sent.createdAt > lastSeen) {
        lastSeen = sent.createdAt;
      }
    } catch {
      textInput.value = text;
    }
  }

  function setOpen(next: boolean): void {
    open = next;
    panel.style.display = open ? "flex" : "none";
    if (open) {
      setBadge(0);
      textInput.focus();
    }
  }

  launcher.addEventListener("click", () => setOpen(!open));
  sendBtn.addEventListener("click", send);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
  saveEmailBtn.addEventListener("click", () => {
    const value = emailInput.value.trim();
    if (!value.includes("@")) return;
    email = value;
    emailGate.style.display = "none";
    textInput.focus();
  });

  const g = globalThis as { PileChat?: PileChatFn };
  const queued = g.PileChat?.q ?? [];
  g.PileChat = ((cmd: string, arg?: unknown) => {
    switch (cmd) {
      case "open":
        setOpen(true);
        break;
      case "close":
        setOpen(false);
        break;
      case "toggle":
        setOpen(!open);
        break;
      case "setUser": {
        const u = arg as { email?: string; name?: string; externalId?: string };
        email = u?.email ?? email;
        name = u?.name ?? name;
        if (u?.externalId) settings.externalId = u.externalId;
        break;
      }
      case "destroy":
        clearTimeout(pollTimer);
        host.remove();
        break;
    }
  }) as PileChatFn;

  void startSession()
    .then(() => {
      poll();
      for (const call of queued) {
        const [cmd, arg] = call as [string, unknown?];
        g.PileChat?.(cmd, arg);
      }
      document.dispatchEvent(new CustomEvent("pile:chat-ready"));
    })
    .catch(() => {
      // invalid key or network — widget stays silent, nothing breaks on the page
    });
}

if (typeof document !== "undefined") {
  boot(readSettings());
}
