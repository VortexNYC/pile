import type { WorkerEnv } from "../platform/middleware.js";

interface SlackFileAttachment {
  url?: string;
  name?: string;
  mimeType?: string;
  fetchData?: () => Promise<Buffer | ArrayBuffer>;
}

interface SlackFileRaw {
  id?: string;
}

export async function captureSlackAttachments(
  env: WorkerEnv,
  organizationId: string,
  issueId: string,
  message: {
    attachments: SlackFileAttachment[];
    raw: unknown;
  }
): Promise<void> {
  if (message.attachments.length === 0) return;

  const raw = message.raw as Record<string, unknown>;
  const files = Array.isArray(raw.files) ? raw.files : [];

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(organizationId);

  for (let i = 0; i < message.attachments.length; i++) {
    const attachment = message.attachments[i];
    const file = files[i] as SlackFileRaw | undefined;
    const fileId = file?.id ?? `unknown-${i}`;
    const url = attachment.url ?? "";

    let r2Key: string | null = null;
    if (attachment.fetchData && env.ATTACHMENTS_BUCKET) {
      try {
        const data = await attachment.fetchData();
        r2Key = `attachments/${organizationId}/${issueId}/${fileId}`;
        await env.ATTACHMENTS_BUCKET.put(r2Key, data, {
          httpMetadata: {
            contentType: attachment.mimeType ?? "application/octet-stream",
            contentDisposition: `attachment; filename="${attachment.name ?? fileId}"`,
          },
        });
      } catch {
        // best effort; still record the attachment metadata
        r2Key = null;
      }
    }

    await stub.createAttachment({
      issueId,
      linearId: fileId,
      url,
      title: attachment.name ?? null,
      subtitle: attachment.mimeType ?? null,
      r2Key,
    });
  }
}
