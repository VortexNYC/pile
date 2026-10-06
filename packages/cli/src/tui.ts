// Shared OpenTUI chrome for the interactive pile commands (fleet, inbox,
// support, home): renderer lifecycle, the table/detail two-pane layout,
// status line, modal prompts, and the palette. Commands keep their model
// and row painting; everything that was copy-pasted per command lives here
// (PILE-296).

export type OtModule = typeof import("@opentui/core");
export type CliRenderer = import("@opentui/core").CliRenderer;
export type TextChunk = import("@opentui/core").TextChunk;
export type Renderable = import("@opentui/core").Renderable;

export type TuiKey = {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type StatusTone = "live" | "queued" | "warn" | "ok" | "fail" | "muted";

export const TONE_COLORS = {
  live: "#4ade80",
  queued: "#22d3ee",
  warn: "#facc15",
  ok: "#60a5fa",
  fail: "#f87171",
  muted: "#6b7280",
} as const satisfies Record<StatusTone, string>;

export const TUI = {
  fg: "#d1d5db",
  muted: "#9ca3af",
  link: "#93c5fd",
  border: "#374151",
  borderFocused: "#60a5fa",
  borderDim: "#1f2937",
  selectedBg: "#1e3a5f",
  modalBg: "#111827",
} as const;

// Rows outside the table viewport: status line (1) + box border (2) + header
// row (1).
export const TABLE_CHROME_ROWS = 4;
export const MAX_DETAIL_LINES = 4000;

export type TuiPromptOptions = {
  readonly title: string;
  readonly placeholder?: string;
  readonly initial?: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
};

export function tuiUnavailableError(command: string, error: unknown): Error {
  const message = errorMessage(error);
  // `bun build --compile` leaves an unresolvable dynamic import in the bundle
  // instead of failing the build, so a binary produced without @opentui
  // resolvable (e.g. pruned optional deps) only blows up here. Name that
  // build failure instead of blaming the terminal.
  if (/cannot find (?:module|package)[^\n]*@opentui\//iu.test(message)) {
    return new Error(
      `${command}: this pile build does not include OpenTUI — @opentui/core was not resolvable at build/install time. Rebuild with dependencies installed or use a released binary.`,
      { cause: error }
    );
  }
  return new Error(
    `${command} needs an interactive terminal with OpenTUI support (Bun, or Node.js >= 26.1 with node:ffi): ${message}`,
    { cause: error }
  );
}

// `pile tui-check` — proves the OpenTUI module and its native library load in
// this runtime. `build:bin` runs this against the freshly compiled binary so
// a build that silently left @opentui/core unresolved fails there instead of
// shipping a binary whose TUI commands break at runtime.
export async function checkTuiSupport(): Promise<void> {
  const ot: OtModule = await import("@opentui/core");
  const renderer = await ot.createCliRenderer({ exitOnCtrlC: false });
  renderer.destroy();
}

// Dynamic import keeps the plain (non-TTY) commands loadable where
// OpenTUI's native bits can't start.
export async function createTui(command: string): Promise<{
  ot: OtModule;
  renderer: CliRenderer;
}> {
  let ot: OtModule;
  let renderer: CliRenderer;
  try {
    ot = await import("@opentui/core");
    renderer = await ot.createCliRenderer({ exitOnCtrlC: false });
  } catch (error) {
    throw tuiUnavailableError(command, error);
  }
  return { ot, renderer };
}

export type TwoPaneOptions = {
  readonly ot: OtModule;
  readonly renderer: CliRenderer;
  readonly leftTitle: string;
  readonly rightTitle: string;
  // Left column width, e.g. "48%".
  readonly leftWidth: `${number}%`;
  readonly detailWrapMode: "char" | "word";
  // "markdown" swaps the detail pane to a real Markdown renderable — issue
  // bodies and ticket threads render headings/lists/code instead of raw text.
  readonly detailFormat?: "text" | "markdown";
  // Fleet's log tail: keep the detail pane pinned to the newest lines.
  readonly detailStickyBottom?: boolean;
  // Where to mount the pane subtree — defaults to renderer.root. `pile home`
  // mounts each screen under its own tab container instead.
  readonly mount?: Renderable;
  // False when a host (home) owns the renderer: start() becomes a no-op and
  // destroy() only detaches this pane's subtree.
  readonly ownsRenderer?: boolean;
};

export type TwoPane = {
  // Subtree to (re)mount when a host swaps screens.
  readonly root: Renderable;
  readonly ot: OtModule;
  readonly renderer: CliRenderer;
  start(): void;
  onKey(handler: (key: TuiKey) => void): void;
  tableViewportRows(): number;
  cell(text: string, fg?: string): TextChunk;
  paint(text: string, fg?: string, selected?: boolean): TextChunk[];
  link(url: string, label: string, selected?: boolean): TextChunk[];
  setTable(content: TextChunk[][][]): void;
  setDetail(text: string, title?: string): void;
  scrollDetail(deltaLines: number): void;
  scrollDetailTo(position: "top" | "bottom"): void;
  setFocusedPane(pane: "list" | "detail" | null): void;
  setStatus(line: string): void;
  requestRender(): void;
  // Modal single-line input. Owns the keyboard until submit/cancel.
  promptText(options: TuiPromptOptions): void;
  // `?` cheatsheet overlay. Owns the keyboard until esc/q/enter; onClose lets
  // the screen un-gate its key handler.
  showHelp(lines: readonly string[], onClose?: () => void): void;
  closeModal(): void;
  // True while a modal owns the keyboard — hosts defer tab switches.
  modalOpen(): boolean;
  destroy(): void;
};

export function createTwoPane(options: TwoPaneOptions): TwoPane {
  const { ot, renderer } = options;
  const ownsRenderer = options.ownsRenderer !== false;
  const mount = options.mount ?? renderer.root;

  const root = new ot.BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const panes = new ot.BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 1,
    width: "100%",
  });
  const left = new ot.BoxRenderable(renderer, {
    width: options.leftWidth,
    border: true,
    title: options.leftTitle,
    borderColor: TUI.border,
    flexDirection: "column",
  });
  const table = new ot.TextTableRenderable(renderer, {
    wrapMode: "none",
    columnGap: 1,
    cellPaddingX: 0,
    showBorders: false,
    border: false,
    outerBorder: false,
    width: "100%",
  });
  left.add(table);
  const right = new ot.ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    border: true,
    title: options.rightTitle,
    borderColor: TUI.border,
    scrollY: true,
    ...(options.detailStickyBottom === true
      ? { stickyScroll: true, stickyStart: "bottom" as const }
      : {}),
  });
  const detailText =
    options.detailFormat === "markdown"
      ? new ot.MarkdownRenderable(renderer, {
          content: "",
          syntaxStyle: ot.SyntaxStyle.fromStyles({
            "markup.heading": { fg: "#93c5fd", bold: true },
            "markup.strong": { bold: true },
            "markup.italic": { italic: true },
            "markup.raw": { fg: "#4ade80" },
            "markup.link": { fg: TUI.link, underline: true },
            "markup.quote": { fg: TUI.muted, italic: true },
            "markup.list": { fg: TUI.muted },
          }),
          conceal: true,
          width: "100%",
          fg: TUI.fg,
        })
      : new ot.TextRenderable(renderer, {
          content: "",
          wrapMode: options.detailWrapMode,
          width: "100%",
          fg: TUI.fg,
        });
  right.add(detailText);
  panes.add(left);
  panes.add(right);
  const status = new ot.TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: TUI.muted,
  });
  root.add(panes);
  root.add(status);
  mount.add(root);

  const selectedBg = ot.RGBA.fromHex(TUI.selectedBg);

  let modal: import("@opentui/core").BoxRenderable | null = null;
  let modalKeyHandler: ((key: TuiKey) => void) | null = null;
  const closeModal = () => {
    if (modalKeyHandler !== null) {
      renderer.keyInput.off("keypress", modalKeyHandler);
      modalKeyHandler = null;
    }
    if (modal !== null) {
      renderer.root.remove(modal);
      modal = null;
    }
  };

  return {
    root,
    ot,
    renderer,
    start() {
      if (ownsRenderer) renderer.start();
    },
    onKey(handler) {
      renderer.keyInput.on("keypress", (key) => {
        handler({ name: key.name, ctrl: key.ctrl, shift: key.shift });
      });
    },
    tableViewportRows() {
      return Math.max(1, renderer.height - TABLE_CHROME_ROWS);
    },
    cell(text, fg) {
      return ot.fg(fg ?? TUI.fg)(text);
    },
    paint(text, fg, selected = false) {
      const c = ot.fg(fg ?? TUI.fg)(text);
      return [selected ? { ...c, bg: selectedBg } : c];
    },
    link(url, label, selected = false) {
      return [
        {
          ...ot.link(url)(label),
          ...(selected ? { bg: selectedBg } : {}),
        },
      ];
    },
    setTable(content) {
      table.content = content;
    },
    setDetail(text, title) {
      const lines = text.split("\n");
      detailText.content =
        lines.length > MAX_DETAIL_LINES
          ? lines.slice(-MAX_DETAIL_LINES).join("\n")
          : text;
      if (title !== undefined) right.title = title;
      if (options.detailStickyBottom === true) {
        right.scrollTop = right.scrollHeight;
      }
    },
    scrollDetail(deltaLines) {
      right.scrollTop = Math.max(0, right.scrollTop + deltaLines);
    },
    scrollDetailTo(position) {
      right.scrollTop = position === "bottom" ? right.scrollHeight : 0;
    },
    setFocusedPane(pane) {
      left.borderColor =
        pane === "list"
          ? TUI.borderFocused
          : pane === "detail"
            ? TUI.borderDim
            : TUI.border;
      right.borderColor =
        pane === "detail"
          ? TUI.borderFocused
          : pane === "list"
            ? TUI.borderDim
            : TUI.border;
    },
    setStatus(line) {
      status.content = line;
    },
    requestRender() {
      renderer.requestRender();
    },
    promptText(prompt) {
      closeModal();
      const box = new ot.BoxRenderable(renderer, {
        position: "absolute",
        top: "30%",
        left: "15%",
        width: "70%",
        border: true,
        title: prompt.title,
        borderColor: TUI.borderFocused,
        backgroundColor: TUI.modalBg,
        flexDirection: "column",
        padding: 1,
      });
      const input = new ot.InputRenderable(renderer, {
        placeholder: prompt.placeholder ?? "",
        width: "100%",
      });
      if (prompt.initial !== undefined) {
        input.value = prompt.initial;
      }
      box.add(input);
      renderer.root.add(box);
      modal = box;
      input.on("enter", () => {
        const value = input.value;
        closeModal();
        prompt.onSubmit(value);
      });
      modalKeyHandler = (key) => {
        if (key.name === "escape") {
          closeModal();
          prompt.onCancel();
        }
      };
      renderer.keyInput.on("keypress", modalKeyHandler);
      input.focus();
      renderer.requestRender();
    },
    showHelp(lines, onClose) {
      closeModal();
      const box = new ot.BoxRenderable(renderer, {
        position: "absolute",
        top: "15%",
        left: "20%",
        width: "60%",
        border: true,
        title: "keys",
        borderColor: TUI.borderFocused,
        backgroundColor: TUI.modalBg,
        flexDirection: "column",
        padding: 1,
      });
      const text = new ot.TextRenderable(renderer, {
        content: [...lines, "", "esc · q — close"].join("\n"),
        wrapMode: "word",
        width: "100%",
        fg: TUI.fg,
      });
      box.add(text);
      renderer.root.add(box);
      modal = box;
      modalKeyHandler = (key) => {
        if (
          key.name === "escape" ||
          key.name === "q" ||
          key.name === "return"
        ) {
          closeModal();
          onClose?.();
          renderer.requestRender();
        }
      };
      renderer.keyInput.on("keypress", modalKeyHandler);
      renderer.requestRender();
    },
    closeModal,
    modalOpen() {
      return modal !== null;
    },
    destroy() {
      closeModal();
      if (ownsRenderer) {
        renderer.destroy();
      } else {
        mount.remove(root);
      }
    },
  };
}
