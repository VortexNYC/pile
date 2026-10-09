import { createFileRoute } from "@tanstack/react-router";
import { AuthProvider, VerifyEmailForm } from "@vortex-api/better-auth-ui";

import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_auth/verify-email")({
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <VerifyEmailForm className="w-full" />
    </AuthProvider>
  );
}
