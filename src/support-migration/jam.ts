import { z } from "zod";

import { recordImportMapping } from "../global/import-mappings.js";
import { storeJamCaptureArtifacts } from "../global/jam-capture.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  findSupportTicketByExternalId,
} from "../global/support-tickets.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportRunState,
  ImportSource,
  ImportValidationResult,
} from "../import/types.js";

export const jamSupportCredentialsSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});
export type JamSupportCredentials = z.infer<typeof jamSupportCredentialsSchema>;

export const jamSupportOptionsSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional().default(50),
  cursor: z.string().optional(),
});
export type JamSupportOptions = z.infer<typeof jamSupportOptionsSchema>;

const jamItemSchema = z
  .object({
    jamId: z.string(),
    jamUrl: z.string(),
    teamId: z.string().optional(),
    type: z.enum(["video", "screenshot", "sessionReplay"]).optional(),
    createdAt: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    originalUrl: z.string().optional(),
    origin: z.string().optional(),
    author: z
      .object({
        email: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    recordingLink: z
      .object({
        reference: z.string().optional(),
        submitterComment: z.string().optional(),
      })
      .passthrough()
      .optional(),
    intercom: z
      .object({
        conversationId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    linear: z
      .object({
        issueId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    media: z
      .object({
        videoUrl: z.string().optional(),
        screenshotUrl: z.string().optional(),
      })
      .passthrough()
      .optional(),
    consoleLogs: z.array(z.unknown()).optional(),
    networkRequests: z.array(z.unknown()).optional(),
    userEvents: z.array(z.unknown()).optional(),
    systemInfo: z.record(z.string(), z.unknown()).optional(),
    eventsSummary: z.record(z.string(), z.unknown()).optional(),
    postprocessing: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function jamItemCustomerEmail(item: z.infer<typeof jamItemSchema>): string {
  const email = item.author?.email;
  if (email && email.length > 0) return email;
  return `${item.jamId}@jam.imported`;
}

export const jamSupportImportSource: ImportSource<
  JamSupportCredentials,
  JamSupportOptions
> = {
  name: "jam-support",

  validate(credentials): ImportValidationResult {
    const parsed = jamSupportCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    const { data } = parsed.data;
    if (data.length === 0) {
      return { ok: false, error: "Jam data array is empty" };
    }
    if (
      data.some(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          !item.jamId ||
          !item.jamUrl
      )
    ) {
      return {
        ok: false,
        error: "Every Jam data item must have a jamId and jamUrl",
      };
    }
    return { ok: true };
  },

  async run(
    ctx: ImportContext,
    credentials: JamSupportCredentials,
    options: JamSupportOptions,
    state?: ImportRunState
  ): Promise<ImportBatchResult> {
    const { data } = credentials;
    const limit = state?.limit ?? options.limit;
    const start = Number(state?.cursor ?? options.cursor ?? "0");
    const end = Math.min(start + limit, data.length);

    let created = 0;
    let updated = 0;
    let errors = 0;

    await Promise.all(
      data.slice(start, end).map(async (raw) => {
        const parsed = jamItemSchema.safeParse(raw);
        if (!parsed.success) {
          errors++;
          return;
        }
        const item = parsed.data;

        try {
          const existing = await findSupportTicketByExternalId(
            ctx.db,
            ctx.organizationId,
            item.jamId,
            "jam"
          );

          if (existing) {
            updated++;
            return;
          }

          const customer = await findOrCreateCustomerByEmail(
            ctx.db,
            ctx.organizationId,
            jamItemCustomerEmail(item),
            item.author?.name ?? null,
            "jam"
          );

          const title =
            item.title ?? `Jam ${item.type ?? "capture"} from ${item.jamUrl}`;
          const text = [item.description, item.recordingLink?.submitterComment]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n\n");

          const ticket = await createTicket(ctx.db, {
            organizationId: ctx.organizationId,
            customerId: customer.id,
            title,
            priority: "medium",
            sourceChannel: "capture",
            externalSource: "jam",
            externalId: item.jamId,
            createdAt: item.createdAt,
          });

          const event = await addTicketMessage(
            ctx.db,
            ctx.organizationId,
            ticket.id,
            {
              direction: "inbound",
              textContent: text || `Jam capture: ${item.jamUrl}`,
              markdownContent: text,
              channel: "capture",
              customerId: customer.id,
              actorType: "customer",
              actorId: customer.id,
              createdAt: item.createdAt,
            }
          );

          const origin = ctx.requestHeaders.get("origin") ?? "https://pile.nyc";
          const remoteAttachments: {
            type: "screenshot" | "video";
            url: string;
            contentType: string;
          }[] = [];
          if (item.media?.videoUrl) {
            remoteAttachments.push({
              type: "video",
              url: item.media.videoUrl,
              contentType: "video/webm",
            });
          }
          if (item.media?.screenshotUrl) {
            remoteAttachments.push({
              type: "screenshot",
              url: item.media.screenshotUrl,
              contentType: "image/png",
            });
          }

          const inlineArtifacts: {
            type: "debugger_json" | "log" | "network";
            name: string;
            data: unknown;
          }[] = [];
          if (item.consoleLogs?.length) {
            inlineArtifacts.push({
              type: "log",
              name: "console-logs.json",
              data: item.consoleLogs,
            });
          }
          if (item.networkRequests?.length) {
            inlineArtifacts.push({
              type: "network",
              name: "network-requests.json",
              data: item.networkRequests,
            });
          }
          if (item.userEvents?.length) {
            inlineArtifacts.push({
              type: "log",
              name: "user-events.json",
              data: item.userEvents,
            });
          }
          if (item.systemInfo && Object.keys(item.systemInfo).length > 0) {
            inlineArtifacts.push({
              type: "debugger_json",
              name: "device-info.json",
              data: item.systemInfo,
            });
          }
          if (
            item.eventsSummary &&
            Object.keys(item.eventsSummary).length > 0
          ) {
            inlineArtifacts.push({
              type: "debugger_json",
              name: "events-summary.json",
              data: item.eventsSummary,
            });
          }
          if (
            item.postprocessing &&
            Object.keys(item.postprocessing).length > 0
          ) {
            inlineArtifacts.push({
              type: "debugger_json",
              name: "postprocessing.json",
              data: item.postprocessing,
            });
          }
          if (item.metadata && Object.keys(item.metadata).length > 0) {
            inlineArtifacts.push({
              type: "debugger_json",
              name: "metadata.json",
              data: item.metadata,
            });
          }

          await storeJamCaptureArtifacts(
            ctx.db,
            ctx.env,
            ctx.organizationId,
            origin,
            ticket.id,
            event.id,
            item.jamId,
            remoteAttachments,
            inlineArtifacts
          );

          await recordImportMapping(
            ctx.db,
            ctx.organizationId,
            ctx.jobId,
            "jam-support",
            "ticket",
            item.jamId,
            ticket.id
          );

          created++;
        } catch {
          errors++;
        }
      })
    );

    return {
      counts: {
        tickets: created + updated,
        created,
        updated,
        errors,
      },
      nextCursor: end < data.length ? String(end) : null,
    };
  },
};
