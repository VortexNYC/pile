import type { AnyAuthClient } from "@vortex-api/better-auth-ui";

import { betterAuthClient } from "./better-auth";

const knownRoles = ["owner", "admin", "member"] as const;
type KnownRole = (typeof knownRoles)[number];

function isKnownRole(role: string): role is KnownRole {
  return knownRoles.some((r) => r === role);
}

export function toBetterAuthRole(
  role: string | string[]
): KnownRole | KnownRole[] {
  if (typeof role === "string") {
    return isKnownRole(role) ? role : "member";
  }
  const filtered = role.filter(isKnownRole);
  return filtered.length > 0 ? filtered : ["member"];
}

function cleanLogo(logo: string | null | undefined): string | undefined {
  return typeof logo === "string" && logo.length > 0 ? logo : undefined;
}

let cached: AnyAuthClient | null = null;

export function getBetterAuthUiClient(): AnyAuthClient {
  if (cached !== null) {
    return cached;
  }
  const c = betterAuthClient;
  cached = {
    useSession: () => c.useSession(),
    signOut: () => c.signOut(),
    signIn: {
      email: (args) => c.signIn.email(args),
    },
    signUp: {
      email: (args) => c.signUp.email(args),
    },
    requestPasswordReset: (args) => c.requestPasswordReset(args),
    resetPassword: (args) => c.resetPassword(args),
    sendVerificationEmail: (args) => c.sendVerificationEmail(args),
    verifyEmail: (args) => c.verifyEmail(args),
    updateUser: (args) => c.updateUser(args),
    changeEmail: (args) => c.changeEmail(args),
    changePassword: (args) => c.changePassword(args),
    deleteUser: (args) => c.deleteUser(args),
    listSessions: () => c.listSessions(),
    revokeSession: (args) => c.revokeSession(args),
    revokeOtherSessions: () => c.revokeOtherSessions(),
    listAccounts: () => c.listAccounts(),
    linkSocial: (args) => c.linkSocial(args),
    unlinkAccount: (args) => c.unlinkAccount(args),
    ...(c.twoFactor !== undefined
      ? {
          twoFactor: {
            enable: async (args) => {
              const response = await c.twoFactor.enable(args);
              const data = response.data;
              return {
                data:
                  data && "totpURI" in data
                    ? {
                        totpURI: data.totpURI,
                        backupCodes: data.backupCodes,
                      }
                    : null,
                error: response.error,
              };
            },
            verifyTotp: (args) => c.twoFactor.verifyTotp(args),
            verifyBackupCode: (args) => c.twoFactor.verifyBackupCode(args),
            disable: (args) => c.twoFactor.disable(args),
            generateBackupCodes: (args) =>
              c.twoFactor.generateBackupCodes(args),
          },
        }
      : {}),
    organization: {
      list: () => c.organization.list(),
      create: (args) =>
        c.organization.create({ ...args, logo: cleanLogo(args.logo) }),
      delete: (args) => c.organization.delete(args),
      update: (args) =>
        c.organization.update({
          ...args,
          data: { ...args.data, logo: cleanLogo(args.data.logo) },
        }),
      setActive: (args) => c.organization.setActive(args),
      getFullOrganization: (args) => c.organization.getFullOrganization(args),
      checkSlug: (args) => c.organization.checkSlug(args),
      listUserInvitations: () => c.organization.listUserInvitations(),
      inviteMember: (args) =>
        c.organization.inviteMember({
          ...args,
          role: toBetterAuthRole(args.role),
        }),
      acceptInvitation: (args) => c.organization.acceptInvitation(args),
      rejectInvitation: (args) => c.organization.rejectInvitation(args),
      cancelInvitation: (args) => c.organization.cancelInvitation(args),
      removeMember: (args) => c.organization.removeMember(args),
      updateMemberRole: (args) =>
        c.organization.updateMemberRole({
          ...args,
          role: toBetterAuthRole(args.role),
        }),
      getActiveMemberRole: () => c.organization.getActiveMemberRole(),
    },
  };
  return cached;
}
