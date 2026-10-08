export const APP_BASE = "/app";

/**
 * Map an href (as better-auth-ui and Kumo render them, with the /app mount
 * prefix) to a router path relative to the basepath. Returns null for
 * external URLs, same-origin paths outside /app, and same-page `#`/`?`
 * hrefs, which must stay real anchors.
 */
export function toRouterPath(href: string): string | null {
  if (
    href === "" ||
    /^[#?]/.test(href) ||
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("//")
  ) {
    return null;
  }
  const absolute = href.startsWith("/") ? href : `/${href}`;
  if (absolute === APP_BASE) {
    return "/";
  }
  if (
    absolute.startsWith(`${APP_BASE}/`) ||
    absolute.startsWith(`${APP_BASE}?`)
  ) {
    const rest = absolute.slice(APP_BASE.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  // Same-origin paths outside the console (/api, /agents…) need a real load.
  return href.startsWith("/") ? null : absolute;
}

/** Absolute in-app href, for links rendered outside the router. */
export function appHref(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized === "/" ? APP_BASE : `${APP_BASE}${normalized}`;
}
