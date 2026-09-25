import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin, organization } from "better-auth/plugins";

import { sendEmail } from "../email/send.js";
import { createD1 } from "../global/db.js";
import * as schema from "../global/schema.js";
import { organizationOptions } from "./access.js";
import type { AppEnv } from "./env.js";

// Auth emails (verify, password reset) are user-blocking — a missing EMAIL
// binding used to log a warning and let the request succeed silently, which
// locked users out with no signal. Delegate to the shared sender and let
// failures propagate so the caller sees an error instead.
async function sendAuthEmail(
  env: AppEnv,
  to: string,
  subject: string,
  text: string
): Promise<void> {
  if (!env.EMAIL_FROM) {
    throw new Error("EMAIL_FROM not configured");
  }
  await sendEmail(env, {
    from: env.EMAIL_FROM,
    to,
    subject,
    text,
  });
}

export async function createAuth(env: AppEnv) {
  // samlify + @xmldom are heavy; lazy-importing keeps the SSO plugin out of
  // worker startup CPU (deploy validation) — it parses on first auth use.
  const { sso } = await import("@better-auth/sso");
  const db = createD1(env.D1);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    account: {
      encryptOAuthTokens: true,
    },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async (data) => {
        await sendAuthEmail(
          env,
          data.user.email,
          "Reset your Pile password",
          `Reset your Pile password: ${data.url}`
        );
      },
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendVerificationEmail: async (data) => {
        await sendAuthEmail(
          env,
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
          enabled: true,
          // Per-key limit: 600 requests/minute (~10 req/s).
          timeWindow: 60_000,
          maxRequests: 600,
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
      sso({
        // SSO sign-ins provision membership on the provider's organization.
        // The plugin already restricts provider register/update/delete to
        // organization owners and admins.
        organizationProvisioning: {
          defaultRole: "member",
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
          if (!env.BETTER_AUTH_URL) {
            return;
          }
          const url = `${env.BETTER_AUTH_URL}/api/auth/organization/accept-invitation?id=${encodeURIComponent(data.id)}`;
          await sendAuthEmail(
            env,
            data.email,
            "Invitation to join the workspace",
            `You have been invited to join the workspace. Accept here: ${url}`
          );
        },
      }),
    ],
  });
}
