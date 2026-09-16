export const PAGE_TEXT_MAX_CHARS = 20000;
export const PREFS_KEY = "pileClipperPrefs";

/**
 * Runs inside the page via scripting.executeScript, so it must be
 * self-contained: no references to module scope.
 *
 * @param {number} maxChars
 */
export function extractPageContext(maxChars) {
  const noise =
    "script,style,noscript,template,svg,iframe,nav,header,footer,aside,form";
  const root =
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.body;
  let text = "";
  if (root) {
    const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
    for (const node of clone.querySelectorAll(noise)) {
      node.remove();
    }
    text = clone.innerText ?? clone.textContent ?? "";
  }
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  return {
    url: location.href,
    title: document.title,
    selection: window.getSelection()?.toString() ?? "",
    pageText: text,
  };
}

/**
 * @param {string} dataUrl
 * @returns {{ contentType: string, contentBase64: string } | null}
 */
export function screenshotFromDataUrl(dataUrl) {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { contentType: match[1], contentBase64: match[2] };
}

/**
 * @typedef {object} ClipperPrefs
 * @property {boolean} includeScreenshot
 * @property {boolean} includeSummary
 * @property {boolean} includeFullText
 * @property {string} teamId
 * @property {string} projectId
 * @property {string[]} labelIds
 */

/** @returns {ClipperPrefs} */
export function defaultPrefs() {
  return {
    includeScreenshot: true,
    includeSummary: true,
    includeFullText: false,
    teamId: "",
    projectId: "",
    labelIds: [],
  };
}

/**
 * @param {unknown} value
 * @returns {ClipperPrefs}
 */
export function normalizePrefs(value) {
  const prefs = defaultPrefs();
  if (value === null || typeof value !== "object") {
    return prefs;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.includeScreenshot === "boolean") {
    prefs.includeScreenshot = record.includeScreenshot;
  }
  if (typeof record.includeSummary === "boolean") {
    prefs.includeSummary = record.includeSummary;
  }
  if (typeof record.includeFullText === "boolean") {
    prefs.includeFullText = record.includeFullText;
  }
  if (typeof record.teamId === "string") prefs.teamId = record.teamId;
  if (typeof record.projectId === "string") prefs.projectId = record.projectId;
  if (Array.isArray(record.labelIds)) {
    prefs.labelIds = record.labelIds.filter(
      (id) => typeof id === "string" && id.length > 0
    );
  }
  return prefs;
}

/**
 * @param {{ url: string, title: string, selection: string, pageText?: string }} page
 * @param {ClipperPrefs} prefs
 * @param {{ contentType: string, contentBase64: string } | null} screenshot
 */
export function buildCapturePayload(page, prefs, screenshot) {
  /** @type {{
   *   url: string,
   *   title: string,
   *   selection: string,
   *   pageText?: string,
   *   summarize?: boolean,
   *   includeFullText?: boolean,
   *   screenshot?: { contentType: string, contentBase64: string },
   *   teamId?: string,
   *   projectId?: string,
   *   labelIds?: string[],
   * }} */
  const payload = {
    url: page.url,
    title: page.title,
    selection: page.selection,
    summarize: prefs.includeSummary,
    includeFullText: prefs.includeFullText,
  };
  if (
    (prefs.includeSummary || prefs.includeFullText) &&
    page.pageText &&
    page.pageText.length > 0
  ) {
    payload.pageText = page.pageText;
  }
  if (prefs.includeScreenshot && screenshot) {
    payload.screenshot = screenshot;
  }
  if (prefs.teamId) payload.teamId = prefs.teamId;
  if (prefs.projectId) payload.projectId = prefs.projectId;
  if (prefs.labelIds.length > 0) payload.labelIds = [...prefs.labelIds];
  return payload;
}
