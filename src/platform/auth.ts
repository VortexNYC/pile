import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";

import { createD1 } from "../global/db.js";
import * as schema from "../global/schema.js";
import type { AppEnv } from "./env.js";

export function createAuth(env: AppEnv) {
  const db = createD1(env.D1);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        metadata: { type: "json", required: false },
      },
    },
    plugins: [
      apiKey({
        enableMetadata: true,
        permissions: {
          defaultPermissions: {
            vortex: ["read"],
          },
        },
      }),
      organization({
        teams: { enabled: true },
        schema: {
          organization: {
            additionalFields: {
              metadata: { type: "json", required: false },
            },
          },
          team: {
            additionalFields: {
              metadata: { type: "json", required: false },
            },
          },
        },
      }),
    ],
  });
}
