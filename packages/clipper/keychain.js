export const SESSION_KEY = "pileClipperSession";

/**
 * @typedef {object} ClipperSession
 * @property {string} baseUrl
 * @property {string} token
 * @property {string} workspaceId
 * @property {string} workspaceName
 * @property {string} workspaceSlug
 */

/**
 * @param {unknown} value
 * @returns {value is ClipperSession}
 */
export function isClipperSession(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof record.baseUrl === "string" &&
    record.baseUrl.length > 0 &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.workspaceId === "string" &&
    record.workspaceId.length > 0 &&
    typeof record.workspaceName === "string" &&
    record.workspaceName.length > 0 &&
    typeof record.workspaceSlug === "string" &&
    record.workspaceSlug.length > 0
  );
}

/**
 * Extension keychain: chrome.storage.local / Firefox storage /
 * Safari WebExtension storage (Keychain-backed on Apple platforms).
 *
 * @param {{
 *   get: (keys: string[] | string) => Promise<Record<string, unknown>>,
 *   set: (items: Record<string, unknown>) => Promise<void>,
 *   remove: (keys: string[] | string) => Promise<void>,
 * }} storage
 */
export function createKeychain(storage) {
  return {
    /** @returns {Promise<ClipperSession | null>} */
    async getSession() {
      const items = await storage.get([SESSION_KEY]);
      const session = items[SESSION_KEY];
      return isClipperSession(session) ? session : null;
    },
    /** @param {ClipperSession} session */
    async setSession(session) {
      if (!isClipperSession(session)) {
        throw new Error("Invalid clipper session");
      }
      await storage.set({ [SESSION_KEY]: session });
    },
    async clearSession() {
      await storage.remove(SESSION_KEY);
    },
  };
}
