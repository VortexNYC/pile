/** Only same-app relative redirects are honored — never an open redirect. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/app") || value.startsWith("//")) return undefined;
  return value;
}
