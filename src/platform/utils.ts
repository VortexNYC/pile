export function generateBranchName(
  issueId: string | undefined,
  title: string
): string {
  const id = issueId?.toLowerCase().replace(/\s+/g, "-") ?? "vor";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `${id}-${slug}`;
}

export function parseSessionIdFromUrl(
  sessionUrl: string
): string | undefined {
  const match = sessionUrl.match(/sessions\/([a-f0-9-]+)(?:\/|$)/);
  return match?.[1];
}

export function sessionIsTerminal(session: {
  status: string;
  status_detail: string | null;
  is_archived: boolean;
}): boolean {
  if (session.is_archived) return true;
  if (
    ["completed", "done", "failed", "cancelled", "exit", "error", "suspended"].includes(
      session.status
    )
  )
    return true;
  if (
    ["completed", "error", "failed", "cancelled", "timeout", "exit"].includes(
      session.status_detail || ""
    )
  )
    return true;
  return false;
}
