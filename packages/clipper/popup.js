import { createAuthClient, DEFAULT_BASE_URL } from "./auth.js";
import {
  buildCapturePayload,
  extractPageContext,
  normalizePrefs,
  PAGE_TEXT_MAX_CHARS,
  PREFS_KEY,
  screenshotFromDataUrl,
} from "./capture.js";
import { createKeychain } from "./keychain.js";

function getApi() {
  if (typeof browser !== "undefined" && browser.runtime) {
    return browser;
  }
  return chrome;
}

function callApi(target, method, ...args) {
  const result = method.apply(target, args);
  if (result && typeof result.then === "function") {
    return result;
  }
  return new Promise((resolve, reject) => {
    method.call(target, ...args, (value) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(value);
      }
    });
  });
}

function createStorage(api) {
  return {
    get(keys) {
      return callApi(api.storage.local, api.storage.local.get, keys);
    },
    set(items) {
      return callApi(api.storage.local, api.storage.local.set, items);
    },
    remove(keys) {
      return callApi(api.storage.local, api.storage.local.remove, keys);
    },
  };
}

async function getActiveTab(api) {
  const tabs = await callApi(api.tabs, api.tabs.query, {
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

async function getPageInfo(api, tab) {
  const results = await callApi(api.scripting, api.scripting.executeScript, {
    target: { tabId: tab.id },
    func: extractPageContext,
    args: [PAGE_TEXT_MAX_CHARS],
  });
  return results[0].result;
}

/**
 * @returns {Promise<{ contentType: string, contentBase64: string } | null>}
 */
async function captureScreenshot(api, tab) {
  try {
    const dataUrl = await callApi(
      api.tabs,
      api.tabs.captureVisibleTab,
      tab.windowId,
      {
        format: "png",
      }
    );
    return typeof dataUrl === "string" ? screenshotFromDataUrl(dataUrl) : null;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLSelectElement} select
 * @param {Array<{ id: string, label: string }>} items
 * @param {string | string[]} selected
 * @param {string | null} placeholder
 */
function fillSelect(select, items, selected, placeholder) {
  const selectedIds = new Set(Array.isArray(selected) ? selected : [selected]);
  select.replaceChildren();
  if (placeholder !== null) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    select.append(option);
  }
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    option.selected = selectedIds.has(item.id);
    select.append(option);
  }
}

function showStatus(element, message, type) {
  element.textContent = message;
  element.className = `status ${type ?? ""}`;
}

function showPanel(name) {
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

document.addEventListener("DOMContentLoaded", () => {
  const api = getApi();
  const keychain = createKeychain(createStorage(api));
  const auth = createAuthClient({
    fetch: globalThis.fetch.bind(globalThis),
    getOrigin: () => location.origin,
  });

  const status = requireElement("status");
  const emailInput = requireElement("email");
  const passwordInput = requireElement("password");
  const signInButton = requireElement("sign-in");
  const workspaceList = requireElement("workspace-list");
  const workspaceLabel = requireElement("workspace");
  const captureButton = requireElement("capture");
  const signOutButton = requireElement("sign-out");
  const screenshotToggle = /** @type {HTMLInputElement} */ (
    requireElement("include-screenshot")
  );
  const summaryToggle = /** @type {HTMLInputElement} */ (
    requireElement("include-summary")
  );
  const fullTextToggle = /** @type {HTMLInputElement} */ (
    requireElement("include-full-text")
  );
  const teamSelect = /** @type {HTMLSelectElement} */ (requireElement("team"));
  const projectSelect = /** @type {HTMLSelectElement} */ (
    requireElement("project")
  );
  const labelsSelect = /** @type {HTMLSelectElement} */ (
    requireElement("labels")
  );
  const storage = createStorage(api);

  /** @type {string | null} */
  let pendingCookie = null;

  function readPrefs() {
    return normalizePrefs({
      includeScreenshot: screenshotToggle.checked,
      includeSummary: summaryToggle.checked,
      includeFullText: fullTextToggle.checked,
      teamId: teamSelect.value,
      projectId: projectSelect.value,
      labelIds: Array.from(labelsSelect.selectedOptions, (o) => o.value),
    });
  }

  async function savePrefs() {
    await storage.set({ [PREFS_KEY]: readPrefs() });
  }

  /**
   * @param {import("./keychain.js").ClipperSession} session
   */
  async function loadRoutingOptions(session) {
    const items = await storage.get([PREFS_KEY]);
    const prefs = normalizePrefs(items[PREFS_KEY]);
    screenshotToggle.checked = prefs.includeScreenshot;
    summaryToggle.checked = prefs.includeSummary;
    fullTextToggle.checked = prefs.includeFullText;
    try {
      const options = await auth.listRoutingOptions(
        session.baseUrl,
        session.token,
        session.workspaceId
      );
      fillSelect(
        teamSelect,
        options.teams.map((t) => ({ id: t.id, label: `${t.key} · ${t.name}` })),
        prefs.teamId,
        "Default team"
      );
      fillSelect(
        projectSelect,
        options.projects.map((p) => ({ id: p.id, label: p.name })),
        prefs.projectId,
        "No project"
      );
      fillSelect(
        labelsSelect,
        options.labels.map((l) => ({ id: l.id, label: l.name })),
        prefs.labelIds,
        null
      );
    } catch (error) {
      showStatus(status, String(error.message ?? error), "error");
    }
  }

  function renderSignedIn(session) {
    pendingCookie = null;
    workspaceLabel.textContent = session.workspaceName;
    showPanel("signed-in");
    void loadRoutingOptions(session);
  }

  function renderSignIn() {
    pendingCookie = null;
    passwordInput.value = "";
    showPanel("sign-in");
  }

  /**
   * @param {Array<{ id: string, name: string, slug: string }>} workspaces
   */
  function renderWorkspacePicker(workspaces) {
    workspaceList.replaceChildren();
    for (const workspace of workspaces) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = workspace.name;
      button.dataset.workspaceId = workspace.id;
      workspaceList.append(button);
    }
    showPanel("workspaces");
  }

  /**
   * @param {string} cookie
   * @param {{ id: string, name: string, slug: string }} workspace
   */
  async function authorizeWorkspace(cookie, workspace) {
    const authorized = await auth.authorize(
      DEFAULT_BASE_URL,
      cookie,
      workspace.id
    );
    const session = {
      baseUrl: DEFAULT_BASE_URL,
      token: authorized.token,
      workspaceId: authorized.workspace.id,
      workspaceName: authorized.workspace.name,
      workspaceSlug: authorized.workspace.slug,
    };
    await keychain.setSession(session);
    renderSignedIn(session);
    showStatus(status, `Signed in to ${session.workspaceName}`, "success");
  }

  keychain.getSession().then((session) => {
    if (session) {
      renderSignedIn(session);
    } else {
      renderSignIn();
    }
  });

  signInButton.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showStatus(status, "Enter your Pile email and password", "error");
      return;
    }

    signInButton.disabled = true;
    showStatus(status, "Signing in…", "");
    try {
      const { cookie } = await auth.signIn(DEFAULT_BASE_URL, email, password);
      const workspaces = await auth.listWorkspaces(DEFAULT_BASE_URL, cookie);
      if (workspaces.length === 0) {
        throw new Error("No workspaces found for this account");
      }
      if (workspaces.length === 1) {
        await authorizeWorkspace(cookie, workspaces[0]);
        return;
      }
      pendingCookie = cookie;
      renderWorkspacePicker(workspaces);
      showStatus(status, "Choose a workspace", "");
    } catch (error) {
      showStatus(status, String(error.message ?? error), "error");
    } finally {
      signInButton.disabled = false;
    }
  });

  workspaceList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    const workspaceId = target.dataset.workspaceId;
    if (!workspaceId || !pendingCookie) {
      return;
    }
    target.disabled = true;
    showStatus(status, "Authorizing…", "");
    try {
      await authorizeWorkspace(pendingCookie, {
        id: workspaceId,
        name: target.textContent ?? workspaceId,
        slug: workspaceId,
      });
    } catch (error) {
      showStatus(status, String(error.message ?? error), "error");
    } finally {
      target.disabled = false;
    }
  });

  for (const control of [
    screenshotToggle,
    summaryToggle,
    fullTextToggle,
    teamSelect,
    projectSelect,
    labelsSelect,
  ]) {
    control.addEventListener("change", () => {
      void savePrefs();
    });
  }

  signOutButton.addEventListener("click", async () => {
    await keychain.clearSession();
    await storage.remove(PREFS_KEY);
    renderSignIn();
    showStatus(status, "Signed out", "");
  });

  captureButton.addEventListener("click", async () => {
    const session = await keychain.getSession();
    if (!session) {
      renderSignIn();
      showStatus(status, "Sign in to Pile first", "error");
      return;
    }

    captureButton.disabled = true;
    showStatus(status, "Capturing…", "");
    try {
      const prefs = readPrefs();
      const tab = await getActiveTab(api);
      const [page, screenshot] = await Promise.all([
        getPageInfo(api, tab),
        prefs.includeScreenshot ? captureScreenshot(api, tab) : null,
      ]);
      if (prefs.includeScreenshot && !screenshot) {
        showStatus(status, "Screenshot unavailable, capturing without it…", "");
      }
      const issue = await auth.capture(
        session.baseUrl,
        session.token,
        session.workspaceId,
        buildCapturePayload(page, prefs, screenshot)
      );
      const identifier =
        issue &&
        typeof issue === "object" &&
        typeof issue.identifier === "string"
          ? issue.identifier
          : "issue";
      showStatus(status, `Captured ${identifier}`, "success");
    } catch (error) {
      showStatus(status, String(error.message ?? error), "error");
    } finally {
      captureButton.disabled = false;
    }
  });
});
