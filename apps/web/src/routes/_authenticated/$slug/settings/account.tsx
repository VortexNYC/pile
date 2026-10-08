import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  ChangePasswordForm,
  SessionList,
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
      <Page title="Account" description="Your profile, password, and devices.">
        <SettingsStack>
          <UserProfileForm className="w-full max-w-none" />
          <ChangePasswordForm className="w-full max-w-none" />
          <SessionList className="w-full max-w-none" />
        </SettingsStack>
      </Page>
    </AuthProvider>
  );
}
