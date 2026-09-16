export const DEFAULT_BASE_URL = "https://pile.nyc";

/**
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * @param {string} text
 * @param {number} status
 * @returns {string}
 */
export function parseErrorMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.message === "string" &&
      parsed.message.length > 0
    ) {
      return parsed.message;
    }
  } catch {
    // fall through
  }
  return text.length > 0 ? text : `Request failed (${status})`;
}

/**
 * @param {Headers} headers
 * @returns {string | null}
 */
export function sessionTokenFromHeaders(headers) {
  const getSetCookie = headers.getSetCookie;
  const cookies =
    typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  const headerCookie = headers.get("set-cookie");
  const all = headerCookie ? [...cookies, headerCookie] : cookies;
  for (const cookie of all) {
    const match = cookie.match(
      /(?:^|,\s*)(?:better-auth\.)?session_token=([^;]+)/
    );
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

/**
 * @param {unknown} body
 * @returns {string | null}
 */
export function sessionTokenFromBody(body) {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const token = /** @type {Record<string, unknown>} */ (body).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * @param {Response} response
 * @param {string} text
 * @returns {string | null}
 */
export function extractSessionToken(response, text) {
  const fromHeaders = sessionTokenFromHeaders(response.headers);
  if (fromHeaders) {
    return fromHeaders;
  }
  try {
    return sessionTokenFromBody(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionToken
 * @returns {string}
 */
export function sessionCookie(sessionToken) {
  return `better-auth.session_token=${sessionToken}`;
}

/**
 * @param {{
 *   fetch?: typeof fetch,
 *   getOrigin: () => string,
 * }} deps
 */
export function createAuthClient(deps) {
  const doFetch = deps.fetch ?? fetch;

  /**
   * @param {string} baseUrl
   * @param {string} path
   * @param {RequestInit} init
   */
  async function request(baseUrl, path, init) {
    const origin = deps.getOrigin();
    const headers = new Headers(init.headers);
    if (!headers.has("Origin")) {
      headers.set("Origin", origin);
    }
    const response = await doFetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(parseErrorMessage(text, response.status));
    }
    if (text.length === 0) {
      return { response, body: null };
    }
    try {
      return { response, body: JSON.parse(text) };
    } catch {
      throw new Error("Unexpected response from Pile");
    }
  }

  return {
    /**
     * @param {string} baseUrl
     * @param {string} email
     * @param {string} password
     * @returns {Promise<{ sessionToken: string, cookie: string }>}
     */
    async signIn(baseUrl, email, password) {
      const { response, body } = await request(
        baseUrl,
        "/api/auth/sign-in/email",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password, rememberMe: true }),
        }
      );
      const sessionToken =
        extractSessionToken(
          response,
          body === null ? "" : JSON.stringify(body)
        ) ?? sessionTokenFromBody(body);
      if (!sessionToken) {
        throw new Error("Sign in succeeded but no session token returned");
      }
      return { sessionToken, cookie: sessionCookie(sessionToken) };
    },

    /**
     * @param {string} baseUrl
     * @param {string} cookie
     * @returns {Promise<Array<{ id: string, name: string, slug: string }>>}
     */
    async listWorkspaces(baseUrl, cookie) {
      const { body } = await request(baseUrl, "/clipper/workspaces", {
        method: "GET",
        headers: { Cookie: cookie },
        credentials: "include",
      });
      if (
        body === null ||
        typeof body !== "object" ||
        !Array.isArray(/** @type {Record<string, unknown>} */ (body).workspaces)
      ) {
        throw new Error("Unexpected workspaces response");
      }
      return /** @type {Record<string, unknown>} */ (body).workspaces.flatMap(
        (item) => {
          if (
            item === null ||
            typeof item !== "object" ||
            typeof item.id !== "string" ||
            typeof item.name !== "string" ||
            typeof item.slug !== "string"
          ) {
            return [];
          }
          return [{ id: item.id, name: item.name, slug: item.slug }];
        }
      );
    },

    /**
     * @param {string} baseUrl
     * @param {string} cookie
     * @param {string} workspaceId
     * @returns {Promise<{ token: string, workspace: { id: string, name: string, slug: string } }>}
     */
    async authorize(baseUrl, cookie, workspaceId) {
      const { body } = await request(baseUrl, "/clipper/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        credentials: "include",
        body: JSON.stringify({ workspaceId }),
      });
      if (
        body === null ||
        typeof body !== "object" ||
        typeof body.token !== "string" ||
        body.token.length === 0 ||
        body.workspace === null ||
        typeof body.workspace !== "object" ||
        typeof body.workspace.id !== "string" ||
        typeof body.workspace.name !== "string" ||
        typeof body.workspace.slug !== "string"
      ) {
        throw new Error("Authorize returned an unexpected response");
      }
      return {
        token: body.token,
        workspace: {
          id: body.workspace.id,
          name: body.workspace.name,
          slug: body.workspace.slug,
        },
      };
    },

    /**
     * @param {string} baseUrl
     * @param {string} token
     * @param {string} workspaceId
     * @param {{ url: string, title: string, selection: string }} page
     */
    async capture(baseUrl, token, workspaceId, page) {
      const { body } = await request(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/capture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            url: page.url,
            title: page.title,
            selection: page.selection,
            source: "pile-clipper",
          }),
        }
      );
      return body;
    },
  };
}
