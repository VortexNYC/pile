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

function getStorage(keys) {
  return callApi(api.storage.local, api.storage.local.get, keys);
}

function setStorage(items) {
  return callApi(api.storage.local, api.storage.local.set, items);
}

async function getActiveTab() {
  const tabs = await callApi(api.tabs, api.tabs.query, {
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

async function getPageInfo() {
  const tab = await getActiveTab();
  const results = await callApi(api.scripting, api.scripting.executeScript, {
    target: { tabId: tab.id },
    func: () => {
      return {
        url: location.href,
        title: document.title,
        selection: window.getSelection().toString(),
      };
    },
  });
  return results[0].result;
}

async function sendCapture(page, config) {
  const baseUrl = config.pileBaseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/workspaces/${encodeURIComponent(config.pileOrgId)}/capture`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.pileApiKey}`,
    },
    body: JSON.stringify({
      url: page.url,
      title: page.title,
      selection: page.selection,
      source: "pile-clipper",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body}`);
  }
  return response.json();
}

function showStatus(element, message, type) {
  element.textContent = message;
  element.className = `status ${type ?? ""}`;
}

const api = getApi();

document.addEventListener("DOMContentLoaded", () => {
  const captureButton = document.getElementById("capture");
  const saveButton = document.getElementById("save");
  const status = document.getElementById("status");
  const settings = document.getElementById("settings");
  const baseUrlInput = document.getElementById("baseUrl");
  const apiKeyInput = document.getElementById("apiKey");
  const orgIdInput = document.getElementById("orgId");

  getStorage(["pileBaseUrl", "pileApiKey", "pileOrgId"]).then((items) => {
    baseUrlInput.value = items.pileBaseUrl ?? "";
    apiKeyInput.value = items.pileApiKey ?? "";
    orgIdInput.value = items.pileOrgId ?? "";
  });

  saveButton.addEventListener("click", async () => {
    const config = {
      pileBaseUrl: baseUrlInput.value.trim(),
      pileApiKey: apiKeyInput.value.trim(),
      pileOrgId: orgIdInput.value.trim(),
    };
    await setStorage(config);
    showStatus(status, "Settings saved", "success");
  });

  captureButton.addEventListener("click", async () => {
    const config = await getStorage(["pileBaseUrl", "pileApiKey", "pileOrgId"]);
    if (!config.pileBaseUrl || !config.pileApiKey || !config.pileOrgId) {
      showStatus(status, "Configure settings first", "error");
      settings.open = true;
      return;
    }

    captureButton.disabled = true;
    showStatus(status, "Capturing…", "");

    try {
      const page = await getPageInfo();
      const issue = await sendCapture(page, config);
      showStatus(status, `Captured ${issue.identifier ?? "issue"}`, "success");
    } catch (error) {
      showStatus(status, String(error.message ?? error), "error");
    } finally {
      captureButton.disabled = false;
    }
  });
});
