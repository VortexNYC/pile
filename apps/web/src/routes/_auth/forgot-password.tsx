import { createFileRoute } from "@tanstack/react-router";
import { AuthProvider, ForgotPasswordForm } from "@vortex-api/better-auth-ui";

import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_auth/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <ForgotPasswordForm
        className="w-full"
        resetPasswordUrl={`${window.location.origin}/app/reset-password`}
        signInUrl="/app/sign-in"
      />
    </AuthProvider>
  );
}
