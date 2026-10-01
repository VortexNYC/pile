// `pile home` (also bare `pile`) — one renderer, tabbed across the three TUI
// surfaces: fleet lanes, issue inbox, support inbox. Each tab is the real
// command running embedded: its own model + poll loop, a kit pane mounted in
// the shared container, and keys routed only while that screen is active
// (PILE-296).

import {
  flagString,
  isJsonObject,
  parseJson,
  resolveConfig,
  type CliDeps,
} from "./cli.js";
import { FLEET_PANE_OPTIONS, createFleetView, fleetCommand } from "./fleet.js";
import { INBOX_PANE_OPTIONS, createInboxView, inboxCommand } from "./inbox.js";
import {
  SUPPORT_PANE_OPTIONS,
  createSupportView,
  supportCommand,
} from "./support.js";
import {
  TUI,
  createTui,
  createTwoPane,
  type CliRenderer,
  type OtModule,
  type TuiKey,
  type TwoPane,
} from "./tui.js";

export type HomeDeps = CliDeps;

type HomeFlags = Readonly<Record<string, string | boolean>>;

type Screen = {
  readonly label: string;
  readonly pane: TwoPane;
  readonly run: () => Promise<number>;
};

// Bare `pile` has no --workspace flag: resolve to the caller's only
// workspace, and require --workspace when the token can see more than one.
async function resolveHomeWorkspace(
  flags: HomeFlags,
  doFetch: typeof fetch,
  baseUrl: string,
  apiKey: string
): Promise<string> {
  const flag =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (flag !== undefined && flag.length > 0) return flag;

  const res = await doFetch(`${baseUrl.replace(/\/$/u, "")}/workspaces`, {
    headers: new Headers({ Authorization: `Bearer ${apiKey}` }),
  });
  if (!res.ok) {
    throw new Error(
      `GET /workspaces returned ${res.status} — pass --workspace <org>`
    );
  }
  const parsed = parseJson(await res.text());
  const workspaces =
    isJsonObject(parsed) && Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((w) =>
            isJsonObject(w) && typeof w.id === "string" ? w.id : null
          )
          .filter((id): id is string => id !== null)
      : [];
  if (workspaces.length === 1) {
    return workspaces[0] ?? "";
  }
  if (workspaces.length === 0) {
    throw new Error("No workspaces visible to this token.");
  }
  throw new Error(
    `Multiple workspaces (${workspaces.join(", ")}) — pass --workspace <org>`
  );
}

function screenContainer(ot: OtModule, renderer: CliRenderer) {
  return new ot.BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
  });
}

export async function homeCommand(
  flags: HomeFlags,
  deps: HomeDeps = {}
): Promise<number> {
  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }
  const doFetch = deps.fetch ?? fetch;
  const workspace = await resolveHomeWorkspace(
    flags,
    doFetch,
    config.baseUrl,
    config.apiKey
  );
  const screenFlags: HomeFlags = { ...flags, workspace };

  const { ot, renderer } = await createTui("pile");

  let resolveQuit!: () => void;
  const quitSignal = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  const root = new ot.BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const tabs = new ot.TabSelectRenderable(renderer, {
    options: [
      { name: "fleet", description: "agent lanes" },
      { name: "issues", description: "issue inbox" },
      { name: "support", description: "ticket triage" },
    ],
    height: 2,
    tabWidth: 16,
    showUnderline: true,
    showDescription: false,
    backgroundColor: "#111827",
    textColor: TUI.muted,
    selectedBackgroundColor: TUI.selectedBg,
    selectedTextColor: TUI.fg,
    focusedBackgroundColor: "#111827",
    focusedTextColor: TUI.fg,
  });
  const container = screenContainer(ot, renderer);
  root.add(tabs);
  root.add(container);
  renderer.root.add(root);

  let active = 0;
  const mounted: TwoPane[] = [];
  const mountPane = (options: {
    readonly leftTitle: string;
    readonly rightTitle: string;
    readonly leftWidth: `${number}%`;
    readonly detailWrapMode: "char" | "word";
    readonly detailStickyBottom?: boolean;
  }): TwoPane =>
    createTwoPane({
      ot,
      renderer,
      mount: container,
      ownsRenderer: false,
      ...options,
    });

  const fleetPane = mountPane(FLEET_PANE_OPTIONS);
  const issuesPane = mountPane(INBOX_PANE_OPTIONS);
  const supportPane = mountPane(SUPPORT_PANE_OPTIONS);
  mounted.push(fleetPane, issuesPane, supportPane);

  // Keys reach a screen only while it is active; the tab bar owns
  // tab/[/]/1-3 globally.
  const gate = (index: number) => (handler: (key: TuiKey) => void) =>
    renderer.keyInput.on("keypress", (key) => {
      if (active === index) {
        handler({ name: key.name, ctrl: key.ctrl, shift: key.shift });
      }
    });

  const fleetView = createFleetView(fleetPane);
  const issuesView = createInboxView(issuesPane);
  const supportView = createSupportView(supportPane);

  const screens: Screen[] = [
    {
      label: "fleet",
      pane: fleetPane,
      run: () =>
        fleetCommand(screenFlags, {
          ...deps,
          quitSignal,
          createView: () => ({
            ...fleetView,
            onKey: gate(0),
          }),
        }),
    },
    {
      label: "issues",
      pane: issuesPane,
      run: () =>
        inboxCommand(screenFlags, {
          ...deps,
          quitSignal,
          createInboxView: () => ({
            ...issuesView,
            onKey: gate(1),
          }),
        }),
    },
    {
      label: "support",
      pane: supportPane,
      run: () =>
        supportCommand(screenFlags, {
          ...deps,
          quitSignal,
          createView: () => ({
            ...supportView,
            onKey: gate(2),
          }),
        }),
    },
  ];

  const setActive = (index: number): void => {
    if (index === active || screens[index] === undefined) return;
    // A modal owns the keyboard on the active screen — finish or esc it
    // before switching.
    if (screens[active]?.pane.modalOpen() === true) return;
    const prev = mounted[active];
    if (prev !== undefined) prev.root.visible = false;
    active = index;
    mounted[active].root.visible = true;
    tabs.setSelectedIndex(index);
    renderer.requestRender();
  };

  for (const [index, pane] of mounted.entries()) {
    pane.root.visible = index === active;
  }
  tabs.setSelectedIndex(active);

  renderer.keyInput.on("keypress", (key) => {
    const k: TuiKey = { name: key.name, ctrl: key.ctrl, shift: key.shift };
    if (k.name === "tab" || k.name === "]") {
      setActive((active + 1) % mounted.length);
      return;
    }
    if (k.name === "[") {
      setActive((active + mounted.length - 1) % mounted.length);
      return;
    }
    if (k.name === "1" || k.name === "2" || k.name === "3") {
      setActive(Number(k.name) - 1);
      return;
    }
    // Screens resolve their own q/ctrl-c; home's only global exit is ctrl-c.
    if (k.ctrl && k.name === "c") resolveQuit();
  });

  renderer.start();
  const running = screens.map((screen) => screen.run());
  try {
    // First screen to exit (q/ctrl-c/crash) wins — then unwind the rest.
    await Promise.race(running);
  } finally {
    resolveQuit();
    await Promise.allSettled(running);
    for (const pane of mounted) pane.destroy();
    renderer.destroy();
  }
  return 0;
}
