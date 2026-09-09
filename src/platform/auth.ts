import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";

import { createD1 } from "../global/db.js";
import * as schema from "../global/schema.js";
import { organizationOptions } from "./access.js";
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
        ...organizationOptions,
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
        sendInvitationEmail: async (data) => {
          if (!env.EMAIL || !env.EMAIL_FROM || !env.BETTER_AUTH_URL) {
            return;
          }
          try {
            const { EmailMessage } = await import("cloudflare:email");
            const url = `${env.BETTER_AUTH_URL}/api/auth/organization/accept-invitation?id=${encodeURIComponent(data.id)}`;
            const raw = [
              `From: ${env.EMAIL_FROM}`,
              `To: ${data.email}`,
              `Subject: Invitation to join the workspace`,
              "MIME-Version: 1.0",
              'Content-Type: text/plain; charset="utf-8"',
              "",
              `You have been invited to join the workspace. Accept here: ${url}`,
            ].join("\r\n");
            await env.EMAIL.send(
              new EmailMessage(env.EMAIL_FROM, data.email, raw)
            );
          } catch {
            // Email is best-effort.
          }
        },
      }),
    ],
  });
}
