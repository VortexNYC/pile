import { createFileRoute } from "@tanstack/react-router";
import { AuthProvider, SignInForm } from "@vortex-api/better-auth-ui";

import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";
import { safeRedirect } from "@/lib/search";

export const Route = createFileRoute("/_auth/sign-in")({
  component: SignInPage,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
});

function SignInPage() {
  const { redirect } = Route.useSearch();
  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <SignInForm
        className="w-full"
        redirectTo={redirect ?? "/app"}
        forgotPasswordHref="/app/forgot-password"
        signUpUrl="/app/sign-up"
        providers={[]}
      />
    </AuthProvider>
  );
}
