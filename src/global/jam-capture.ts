import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import { supportTicketAttachments } from "./schema.js";

export interface JamRemoteAttachment {
  type: "screenshot" | "video";
  url: string;
  contentType: string;
}

export interface JamInlineArtifact {
  type: "debugger_json" | "log" | "network";
  name: string;
  data: unknown;
}

export async function storeJamCaptureArtifacts(
  db: D1Client,
  env: WorkerEnv | undefined,
  organizationId: string,
  origin: string,
  ticketId: string,
  eventId: string,
  jamId: string,
  remoteAttachments: JamRemoteAttachment[],
  inlineArtifacts: JamInlineArtifact[]
): Promise<void> {
  const bucket = env?.ATTACHMENTS_BUCKET;

  const remoteRows = await Promise.all(
    remoteAttachments.map(async (input) => {
      const r2Key = `${organizationId}/jam/${jamId}/${input.type}`;
      let url = input.url;
      let r2Stored: string | null = null;
      if (bucket) {
        try {
          const resp = await fetch(input.url);
          if (resp.ok) {
            const buffer = await resp.arrayBuffer();
            const contentType =
              resp.headers.get("content-type") ?? input.contentType;
            await bucket.put(r2Key, buffer, {
              httpMetadata: { contentType },
            });
            r2Stored = r2Key;
            url = `${origin}/support/capture/artifacts?r2Key=${encodeURIComponent(r2Key)}`;
          }
        } catch {
          // Remote media is not available locally; keep the original URL.
        }
      }
      return {
        id: crypto.randomUUID(),
        organizationId,
        ticketId,
        eventId,
        type: input.type,
        contentType: input.contentType,
        url,
        r2Key: r2Stored,
        createdAt: new Date().toISOString(),
      };
    })
  );

  const inlineRows = (
    await Promise.all(
      inlineArtifacts.map(async (artifact) => {
        const r2Key = `${organizationId}/jam/${jamId}/${artifact.name}`;
        if (!bucket) return null;
        try {
          const buffer = new TextEncoder().encode(
            JSON.stringify(artifact.data)
          );
          await bucket.put(r2Key, buffer, {
            httpMetadata: { contentType: "application/json" },
          });
          const url = `${origin}/support/capture/artifacts?r2Key=${encodeURIComponent(r2Key)}`;
          return {
            id: crypto.randomUUID(),
            organizationId,
            ticketId,
            eventId,
            type: artifact.type,
            contentType: "application/json",
            url,
            r2Key,
            createdAt: new Date().toISOString(),
          };
        } catch {
          // Inline artifact storage failed; skip it.
          return null;
        }
      })
    )
  ).filter((row) => row !== null);

  await Promise.all([
    ...remoteRows.map((row) => db.insert(supportTicketAttachments).values(row)),
    ...inlineRows.map((row) => db.insert(supportTicketAttachments).values(row)),
  ]);
}
