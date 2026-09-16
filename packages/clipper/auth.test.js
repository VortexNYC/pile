import { describe, expect, it, vi } from "vitest";

import {
  createAuthClient,
  DEFAULT_BASE_URL,
  extractSessionToken,
  parseErrorMessage,
  sessionCookie,
  sessionTokenFromBody,
} from "./auth.js";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("clipper auth", () => {
  it("defaults to production Pile", () => {
    expect(DEFAULT_BASE_URL).toBe("https://pile.nyc");
  });

  it("extracts a session token from JSON or Set-Cookie", () => {
    expect(sessionTokenFromBody({ token: "json-token" })).toBe("json-token");
    const cookieResponse = new Response("{}", {
      headers: {
        "Set-Cookie": "better-auth.session_token=cookie-token; Path=/; HttpOnly",
      },
    });
    expect(extractSessionToken(cookieResponse, "{}")).toBe("cookie-token");
    expect(sessionCookie("abc")).toBe("better-auth.session_token=abc");
  });

  it("parses API error messages", () => {
    expect(parseErrorMessage(JSON.stringify({ message: "Nope" }), 401)).toBe(
      "Nope"
    );
    expect(parseErrorMessage("", 500)).toBe("Request failed (500)");
  });

  it("signs in, lists workspaces, and authorizes with the session cookie", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/sign-in/email")) {
        return jsonResponse(200, { token: "sess_1", user: { id: "user_1" } });
      }
      if (url.endsWith("/clipper/workspaces")) {
        return jsonResponse(200, {
          workspaces: [{ id: "org_1", name: "Vortex", slug: "vortex" }],
        });
      }
      if (url.endsWith("/clipper/authorize")) {
        return jsonResponse(201, {
          token: "pile_write_token",
          workspace: { id: "org_1", name: "Vortex", slug: "vortex" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const client = createAuthClient({
      fetch: fetchMock,
      getOrigin: () => "chrome-extension://clipper",
    });

    const signedIn = await client.signIn(
      DEFAULT_BASE_URL,
      "shlomo@vortex.nyc",
      "secret"
    );
    expect(signedIn.cookie).toBe("better-auth.session_token=sess_1");

    const workspaces = await client.listWorkspaces(
      DEFAULT_BASE_URL,
      signedIn.cookie
    );
    expect(workspaces).toEqual([
      { id: "org_1", name: "Vortex", slug: "vortex" },
    ]);

    const authorized = await client.authorize(
      DEFAULT_BASE_URL,
      signedIn.cookie,
      "org_1"
    );
    expect(authorized.token).toBe("pile_write_token");

    const authorizeCall = fetchMock.mock.calls[2];
    const authorizeInit = authorizeCall[1];
    expect(authorizeInit.headers.get("Cookie")).toBe(signedIn.cookie);
    expect(authorizeInit.headers.get("Origin")).toBe(
      "chrome-extension://clipper"
    );
  });

  it("captures with the stored workspace token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { identifier: "VOR-1" })
    );
    const client = createAuthClient({
      fetch: fetchMock,
      getOrigin: () => "chrome-extension://clipper",
    });

    const issue = await client.capture(
      DEFAULT_BASE_URL,
      "pile_write_token",
      "org_1",
      { url: "https://example.com", title: "Example", selection: "hi" }
    );
    expect(issue.identifier).toBe("VOR-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://pile.nyc/workspaces/org_1/capture");
    expect(init.headers.get("Authorization")).toBe("Bearer pile_write_token");
  });
});
