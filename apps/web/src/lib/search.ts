/** Only same-app relative redirects are honored — never an open redirect. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value !== "/app" &&
    !value.startsWith("/app/") &&
    !value.startsWith("/app?")
  )
    return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (
    path.includes("\\") ||
    path.split("/").some((seg) => seg === ".." || seg === ".")
  )
    return undefined;
  return value;
}
