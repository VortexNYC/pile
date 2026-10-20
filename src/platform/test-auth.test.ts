import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-session-test",
      name: "T",
      email: "s@test.x",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.id] });
});

import { createAdminHeaders } from "./test-auth.js";

describe("createAdminHeaders (PILE-456)", () => {
  it("returns session headers, not an API key — the helper moved to minted sessions", async () => {
    const headers = await createAdminHeaders(env as never, "user-session-test");
    expect(headers instanceof Headers).toBe(true);
    expect(headers.get("cookie") ?? "").toContain("session_token");
  });
});
