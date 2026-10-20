import { describe, expect, it } from "vitest";

import { stripApiKeySessionToken } from "./auth-routes.js";

const req = (path: string, bearer = true) =>
  new Request(`https://x${path}`, {
    headers: bearer ? { authorization: "Bearer k1" } : {},
  });
const res = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

describe("stripApiKeySessionToken (PILE-456)", () => {
  it("removes session.token on Bearer get-session responses", async () => {
    const out = await stripApiKeySessionToken(
      req("/api/auth/get-session"),
      res({ session: { token: "sekret", id: "s1" }, user: {} })
    );
    const body = (await out.json()) as { session: { id: string } };
    expect(body.session.id).toBe("s1");
    expect("token" in body.session).toBe(false);
  });
  it("passes through non-get-session and cookie calls untouched", async () => {
    const orig = res({ session: { token: "k" } });
    expect(await stripApiKeySessionToken(req("/api/auth/ok"), orig)).toBe(orig);
    expect(
      await stripApiKeySessionToken(req("/api/auth/get-session", false), orig)
    ).toBe(orig);
  });
});
