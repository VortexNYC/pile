import type { WorkspaceDO } from "../workspace/durable-object.js";

export async function captureSessionPrArtifact(
  stub: DurableObjectStub<WorkspaceDO>,
  sessionId: string,
  actorId: string | undefined,
  prUrl: string | null | undefined
): Promise<void> {
  if (!prUrl) return;
  const activities = await stub.listAgentActivities(sessionId);
  const already = activities.some((activity) => {
    if (activity.type !== "artifact" || !activity.payload) return false;
    try {
      const payload: unknown = JSON.parse(activity.payload);
      return (
        typeof payload === "object" &&
        payload !== null &&
        "url" in payload &&
        (payload as { url?: unknown }).url === prUrl
      );
    } catch {
      return false;
    }
  });
  if (already) return;
  await stub.addAgentSessionArtifact({
    sessionId,
    actorId,
    name: "Pull request",
    type: "pr",
    url: prUrl,
  });
}
