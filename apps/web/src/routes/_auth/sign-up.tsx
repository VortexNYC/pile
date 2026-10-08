import { createFileRoute } from "@tanstack/react-router";
import { AuthProvider, SignUpForm } from "@vortex-api/better-auth-ui";

import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";
import { safeRedirect } from "@/lib/search";

export const Route = createFileRoute("/_auth/sign-up")({
  component: SignUpPage,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
});

function SignUpPage() {
  const { redirect } = Route.useSearch();
  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <SignUpForm
        className="w-full"
        redirectTo={redirect ?? "/app"}
        signInUrl="/app/sign-in"
        providers={[]}
      />
    </AuthProvider>
  );
}
