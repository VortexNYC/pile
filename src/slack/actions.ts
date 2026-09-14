export async function handleViewInPile(event: unknown): Promise<void> {
  if (typeof event !== "object" || event === null) return;

  const record = event as Record<string, unknown>;
  const value = record.value;
  const thread = record.thread;

  if (typeof value !== "string" || !thread || typeof thread !== "object")
    return;

  const threadRecord = thread as Record<string, unknown>;
  const post = threadRecord.post;
  if (typeof post !== "function") return;

  await post.call(thread, `Open in Pile: ${value}`);
}
