import { apiKeyClient } from "@better-auth/api-key/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same-origin: the Worker serves this SPA at /app and Better Auth at
// /api/auth, so the session cookie rides every request with no CORS.
// apiKeyClient matches the server's apiKey plugin — workspace API keys for
// CLI/agent access surface in Settings → Developer.
export const betterAuthClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  fetchOptions: {
    credentials: "include",
    // Same local-dev bearer as lib/api.ts — lets get-session resolve a real
    // session against a proxied API when a key is configured.
    headers:
      typeof import.meta.env.VITE_PILE_API_KEY === "string" &&
      import.meta.env.VITE_PILE_API_KEY.length > 0
        ? { Authorization: `Bearer ${import.meta.env.VITE_PILE_API_KEY}` }
        : undefined,
  },
  plugins: [organizationClient(), apiKeyClient()],
});
