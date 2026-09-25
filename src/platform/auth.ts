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
  // samlify + @xmldom are heavy; lazy-importing keeps the SSO/SCIM plugins
  // out of worker startup CPU (deploy validation) — they parse on first use.
  const [{ sso }, { scim }] = await Promise.all([
    import("@better-auth/sso"),
    import("@better-auth/scim"),
  ]);
  const db = createD1(env.D1);

  const drizzleFactory = drizzleAdapter(db, { provider: "sqlite", schema });

  return betterAuth({
    // D1 has no interactive transactions (BEGIN is rejected), so we can't set
    // the drizzle adapter's `transaction: true`. The SCIM plugin requires the
    // adapterConfig flag to be a function; providing one makes the adapter
    // factory run transactional callbacks through its built-in sequential
    // fallback — the same guarantee every non-transactional adapter has.
    database: (options) => {
      const instance = drizzleFactory(options);
      const adapterConfig = instance.options?.adapterConfig;
      if (adapterConfig && typeof adapterConfig.transaction !== "function") {
        adapterConfig.transaction = async (callback) => callback(instance);
      }
      return instance;
    },
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
          // SCIM managed credentials are bearer tokens too — leave them for
          // the SCIM plugin's own verifier.
          if (ctx.path?.startsWith("/scim/")) {
            return null;
          }
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
      scim({
        // No code-defined connections — workspace admins mint managed
        // connections via our admin route, scoped by provisioningDomainId =
        // organizationId.
        connections: [],
        managedConnections: {
          credentialHashSecret:
            env.SCIM_CREDENTIAL_SECRET ?? env.BETTER_AUTH_SECRET,
        },
        identity: {
          // SCIM-deactivated users lose API access: ban mirrors the
          // directory's active flag onto the Better Auth user.
          reconcileUser: async (input, context) => {
            if (!input.active) {
              await context.database.update({
                model: "user",
                where: [{ field: "id", value: input.userId }],
                update: { banned: true, banReason: "scim.deactivated" },
              });
            } else {
              await context.database.update({
                model: "user",
                where: [{ field: "id", value: input.userId }],
                update: { banned: false, banReason: null },
              });
            }
          },
        },
        projection: {
          // Group display names map to member roles; anything unrecognized
          // falls back to plain membership.
          roles: {
            map: (input) =>
              input.source.type === "group" ? [input.source.displayName] : [],
            exists: (input) =>
              ["member", "admin", "owner"].includes(input.role),
          },
          // The provisioning domain is the organization. Reconcile writes a
          // member row for active users, removes it when deactivated.
          reconcileUser: async (input, context) => {
            const database = context.database;
            const existing = await database.findOne({
              model: "member",
              where: [
                {
                  field: "organizationId",
                  value: input.provisioningDomainId,
                },
                { field: "userId", value: input.userId },
              ],
            });
            const role = input.grants[0]?.role ?? "member";
            if (!input.active) {
              if (
                existing &&
                typeof existing === "object" &&
                "id" in existing
              ) {
                await database.delete({
                  model: "member",
                  where: [
                    { field: "id", value: (existing as { id: string }).id },
                  ],
                });
              }
              return;
            }
            if (existing && typeof existing === "object" && "id" in existing) {
              const record = existing as { id: string; role?: string };
              if (record.role !== role) {
                await database.update({
                  model: "member",
                  where: [{ field: "id", value: record.id }],
                  update: { role },
                });
              }
              return;
            }
            await database.create({
              model: "member",
              data: {
                id: crypto.randomUUID(),
                organizationId: input.provisioningDomainId,
                userId: input.userId,
                role,
                createdAt: new Date(),
              },
            });
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
