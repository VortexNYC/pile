import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db.insert(userTable).values({
    id: "user-session-test",
    name: "T",
    email: "s@test.x",
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [userTable.id] });
});

import { sessionHeadersForUser } from "./session.js";

describe("sessionHeadersForUser (PILE-456)", () => {
  it("mints signed better-auth session headers for a verified caller", async () => {
    const headers = await sessionHeadersForUser(
      env as never,
      "user-session-test"
    );
    const cookie = headers.get("cookie") ?? "";
    expect(cookie).toContain("session_token=");
  });
});
