import posthog from "posthog-js";

const DEFAULT_POSTHOG_KEY = "phc_ts2JiKlSqvEC0Cjt68HFUkg3mZnY6CG57QkguxWmn5Y";

export const PRODUCTION_HOSTS = new Set(["pile.nyc", "app.pile.nyc"]);

let initialized = false;

/** PostHog — pageviews, autocapture, exception capture, session replay (URL-gated
 * on the project side), identify by member email once a session resolves. */
export function initPosthog() {
  if (initialized || typeof window === "undefined") return;
  const isProdHost = PRODUCTION_HOSTS.has(window.location.hostname);
  const apiKey =
    import.meta.env.VITE_POSTHOG_KEY ??
    (isProdHost ? DEFAULT_POSTHOG_KEY : undefined);
  if (!apiKey) return;
  posthog.init(apiKey, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
    capture_pageview: true,
    capture_pageleave: true,
    capture_exceptions: true,
    enable_recording_console_log: true,
    session_recording: { maskAllInputs: true },
    persistence: "localStorage+cookie",
    loaded: (client) => client.register({ product: "pile" }),
  });
  initialized = true;
}

export function identifyPosthog(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}) {
  if (!initialized) return;
  posthog.identify(user.id, {
    ...(user.email ? { email: user.email } : {}),
    ...(user.name ? { name: user.name } : {}),
  });
}

export function resetPosthog() {
  if (!initialized) return;
  posthog.reset();
}
