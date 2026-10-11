import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  ChangeEmailForm,
  ChangePasswordForm,
  ConnectedAccounts,
  DeleteAccountForm,
  DisableTwoFactorForm,
  EnableTwoFactorForm,
  GenerateBackupCodesForm,
  SessionList,
  SetPasswordForm,
  SettingsStack,
  UserProfileForm,
} from "@vortex-api/better-auth-ui";

import { Page } from "@/components/page";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_authenticated/$slug/settings/account")({
  component: AccountSettings,
});

function AccountSettings() {
  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <Page
        title="Account"
        description="Your profile, credentials, and sessions."
      >
        <SettingsStack>
          <UserProfileForm className="w-full max-w-none" />
          <ChangeEmailForm className="w-full max-w-none" />
          <ConnectedAccounts className="w-full max-w-none" />
          <SetPasswordForm className="w-full max-w-none" />
          <ChangePasswordForm className="w-full max-w-none" />
          <SessionList className="w-full max-w-none" showRevokeOthersAction />
          <EnableTwoFactorForm className="w-full max-w-none" />
          <DisableTwoFactorForm className="w-full max-w-none" />
          <GenerateBackupCodesForm className="w-full max-w-none" />
          <DeleteAccountForm className="w-full max-w-none" />
        </SettingsStack>
      </Page>
    </AuthProvider>
  );
}
