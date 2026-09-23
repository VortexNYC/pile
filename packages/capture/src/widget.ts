/**
 * Minimal embeddable report launcher — a floating button + small form that
 * calls `capture.report()`. Dependency-free, inline styles, no framework.
 */
import type { CaptureReportOptions, CaptureResult } from "./types.js";

export interface CaptureMountOptions {
  /** Button label. Defaults to "Report a bug". */
  label?: string;
  /** Which corner the launcher sits in. Defaults to bottom-right. */
  position?: "bottom-right" | "bottom-left";
  /** Pre-fill / lock the reporter email. Skips the email field. */
  email?: string;
  /** Take a screenshot automatically when the form submits. Default true. */
  screenshot?: boolean;
  /** Custom submit handler — replaces the default report() call. */
  onSubmit?: (fields: {
    email: string;
    description: string;
  }) => Promise<CaptureResult> | CaptureResult;
  /** Called after a successful submission (default or custom). */
  onSubmitted?: (result: CaptureResult) => void;
  /** Called when submission throws. */
  onError?: (error: unknown) => void;
}

export interface CaptureWidgetHandle {
  unmount: () => void;
}

const WIDGET_STYLES = {
  button:
    "position:fixed;z-index:2147483000;padding:8px 14px;border:0;border-radius:8px;" +
    "background:#111;color:#fff;font:500 13px/1.4 system-ui,sans-serif;cursor:pointer;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.25);",
  panel:
    "position:fixed;z-index:2147483001;width:280px;padding:16px;border-radius:10px;" +
    "background:#fff;color:#111;font:400 13px/1.5 system-ui,sans-serif;" +
    "box-shadow:0 8px 32px rgba(0,0,0,.3);",
  field:
    "width:100%;box-sizing:border-box;margin:0 0 8px;padding:8px;border:1px solid #ddd;" +
    "border-radius:6px;font:inherit;",
  submit:
    "width:100%;padding:8px;border:0;border-radius:6px;background:#111;color:#fff;" +
    "font:500 13px/1.4 system-ui,sans-serif;cursor:pointer;",
  status: "margin:8px 0 0;font-size:12px;",
} as const;

export function mountCaptureWidget(
  report: (options: CaptureReportOptions) => Promise<CaptureResult>,
  options: CaptureMountOptions = {}
): CaptureWidgetHandle {
  if (typeof document === "undefined") {
    return { unmount: () => {} };
  }

  const root = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = options.label ?? "Report a bug";
  const vertical = "bottom:20px;";
  const horizontal =
    options.position === "bottom-left" ? "left:20px;" : "right:20px;";
  button.style.cssText = WIDGET_STYLES.button + vertical + horizontal;
  root.appendChild(button);

  let panel: HTMLDivElement | null = null;
  let busy = false;

  const closePanel = () => {
    panel?.remove();
    panel = null;
  };

  const openPanel = () => {
    closePanel();
    panel = document.createElement("div");
    panel.style.cssText = WIDGET_STYLES.panel + "bottom:64px;" + horizontal;

    const emailField = document.createElement("input");
    emailField.type = "email";
    emailField.required = true;
    emailField.placeholder = "you@company.com";
    emailField.style.cssText = WIDGET_STYLES.field;
    if (options.email) {
      emailField.value = options.email;
      emailField.readOnly = true;
    }

    const description = document.createElement("textarea");
    description.rows = 3;
    description.placeholder = "What went wrong?";
    description.style.cssText = WIDGET_STYLES.field + "resize:vertical;";

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Send report";
    submit.style.cssText = WIDGET_STYLES.submit;

    const status = document.createElement("div");
    status.style.cssText = WIDGET_STYLES.status;

    const form = document.createElement("form");
    form.append(emailField, description, submit, status);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      busy = true;
      submit.disabled = true;
      status.textContent = "Sending…";
      void (async () => {
        try {
          const fields = {
            email: emailField.value.trim(),
            description: description.value.trim(),
          };
          const result = options.onSubmit
            ? await options.onSubmit(fields)
            : await report({
                email: fields.email,
                description: fields.description || undefined,
                screenshot: options.screenshot === false ? undefined : "auto",
              });
          status.textContent = "Report sent. Thanks!";
          options.onSubmitted?.(result);
          setTimeout(closePanel, 1500);
        } catch (error) {
          status.textContent = "Failed to send — try again.";
          options.onError?.(error);
        } finally {
          busy = false;
          submit.disabled = false;
        }
      })();
    });

    panel.appendChild(form);
    root.appendChild(panel);
    emailField.focus();
  };

  button.addEventListener("click", () => {
    if (panel) {
      closePanel();
    } else {
      openPanel();
    }
  });

  document.body.appendChild(root);
  return {
    unmount: () => {
      closePanel();
      root.remove();
    },
  };
}
