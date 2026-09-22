import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin, organization } from "better-auth/plugins";

import { createD1 } from "../global/db.js";
import * as schema from "../global/schema.js";
import { organizationOptions } from "./access.js";
import type { AppEnv } from "./env.js";

async function sendEmail(
  env: AppEnv,
  kind: string,
  to: string,
  subject: string,
  text: string
) {
  if (!env.EMAIL || !env.EMAIL_FROM) {
    console.warn(
      JSON.stringify({
        event: "email_skipped",
        kind,
        reason: "no EMAIL binding or EMAIL_FROM",
      })
    );
    return;
  }
  try {
    const { EmailMessage } = await import("cloudflare:email");
    const raw = [
      `From: ${env.EMAIL_FROM}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      text,
    ].join("\r\n");
    await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, to, raw));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "email_send_failed",
        kind,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

export function createAuth(env: AppEnv) {
  const db = createD1(env.D1);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async (data) => {
        await sendEmail(
          env,
          "password_reset",
          data.user.email,
          "Reset your Pile password",
          `Reset your Pile password: ${data.url}`
        );
      },
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendVerificationEmail: async (data) => {
        await sendEmail(
          env,
          "email_verification",
          data.user.email,
          "Verify your Pile email",
          `Verify your Pile email: ${data.url}`
        );
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    },
    advanced: {
      ipAddress: {
        // Cloudflare sets cf-connecting-ip at the edge; x-forwarded-for is
        // client-supplied and spoofable, so it is not trusted here.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    user: {
      additionalFields: {
        metadata: { type: "json", required: false },
      },
      changeEmail: { enabled: true },
      deleteUser: { enabled: true },
    },
    plugins: [
      apiKey({
        enableMetadata: true,
        enableSessionForAPIKeys: true,
        permissions: {
          defaultPermissions: {
            vortex: ["read"],
          },
        },
        rateLimit: {
          enabled: false,
        },
        customAPIKeyGetter: (ctx) => {
          const auth = ctx.headers?.get("Authorization") ?? "";
          const bearerPrefix = "Bearer ";
          if (auth.startsWith(bearerPrefix)) {
            return auth.slice(bearerPrefix.length).trim();
          }
          return null;
        },
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        adminUserIds: env.BETTER_AUTH_ADMIN_IDS
          ? env.BETTER_AUTH_ADMIN_IDS.split(",")
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
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
          if (!env.BETTER_AUTH_URL) {
            return;
          }
          const url = `${env.BETTER_AUTH_URL}/api/auth/organization/accept-invitation?id=${encodeURIComponent(data.id)}`;
          await sendEmail(
            env,
            "invitation",
            data.email,
            "Invitation to join the workspace",
            `You have been invited to join the workspace. Accept here: ${url}`
          );
        },
      }),
    ],
  });
}
