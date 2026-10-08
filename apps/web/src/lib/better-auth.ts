import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same-origin: the Worker serves this SPA at /app and Better Auth at
// /api/auth, so the session cookie rides every request with no CORS.
export const betterAuthClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  fetchOptions: { credentials: "include" },
  plugins: [organizationClient()],
});
