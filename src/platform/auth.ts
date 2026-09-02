import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";

import { createD1 } from "../global/db.js";
import * as schema from "../global/schema.js";
import type { AppEnv } from "./env.js";

export interface AuthService {
  handler: (request: Request) => Promise<Response>;
}

export function createAuth(env: AppEnv): AuthService {
  const db = createD1(env.D1);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
  }) as AuthService;
}
