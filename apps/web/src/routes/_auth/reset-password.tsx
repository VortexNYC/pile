import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthProvider, ResetPasswordForm } from "@vortex-api/better-auth-ui";

import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_auth/reset-password")({
  component: ResetPasswordPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <ResetPasswordForm
        className="w-full"
        token={token}
        onSuccess={() => {
          void navigate({ to: "/sign-in" });
        }}
      />
    </AuthProvider>
  );
}
