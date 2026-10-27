import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { transcribeCaptureRecording } from "../global/capture-transcript.js";
import { createD1 } from "../global/db.js";
import {
  supportTicketAttachments,
  supportTickets,
  user as userTable,
} from "../global/schema.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  getTicketById,
} from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "https://example.com";
const RECORDING_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const SUMMARY_MODEL = "@cf/meta/llama-3.2-3b-instruct";

interface AiCall {
  model: string;
  inputs: Record<string, unknown>;
}

interface AiStub {
  binding: { run(model: string, inputs: unknown): Promise<unknown> };
  calls: AiCall[];
}

function stubAi(handlers: {
  whisper?: (inputs: Record<string, unknown>) => unknown;
  summary?: (inputs: Record<string, unknown>) => unknown;
}): AiStub {
  const calls: AiCall[] = [];
  return {
    calls,
    binding: {
      run: async (model: string, inputs: unknown) => {
        const call: AiCall = {
          model,
          inputs: inputs as Record<string, unknown>,
        };
        calls.push(call);
        if (model === WHISPER_MODEL && handlers.whisper) {
          return handlers.whisper(call.inputs);
        }
        if (model === SUMMARY_MODEL && handlers.summary) {
          return handlers.summary(call.inputs);
        }
        return {};
      },
    },
  };
}

describe("capture transcript", () => {
  let organizationId: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-transcript",
        name: "Transcript User",
        email: "transcript-user@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });

    const setupHeaders = await createAdminHeaders(env, "user-transcript");
    const workspace = await createWorkspace(db, env, setupHeaders, {
      name: "Capture transcript test",
      slug: `capture-transcript-${crypto.randomUUID()}`,
      key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: "user-transcript",
    });
    organizationId = workspace!.id;
  });

  async function freshTicket() {
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "reporter@example.com",
      "Reporter",
      "capture"
    );
    const ticket = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Bug report",
      priority: "medium",
      sourceChannel: "capture",
    });
    const event = await addTicketMessage(
      db,
      organizationId,
      ticket.id,
      {
        direction: "inbound",
        textContent: "report body",
        channel: "capture",
        customerId: customer.id,
        actorType: "customer",
        actorId: customer.id,
      },
      env
    );
    const sessionId = crypto.randomUUID();
    const recordingR2Key = `${organizationId}/capture/${sessionId}/video/recording.webm`;
    await env.ATTACHMENTS_BUCKET.put(recordingR2Key, RECORDING_BYTES, {
      httpMetadata: { contentType: "video/webm" },
    });
    return {
      db,
      ticket,
      eventId: event.id,
      recordingR2Key,
      artifactPrefix: `${organizationId}/capture/${sessionId}`,
    };
  }

  it("writes transcript artifacts and a ticket message, and regenerates a placeholder title", async () => {
    const { db, ticket, eventId, recordingR2Key, artifactPrefix } =
      await freshTicket();
    const stub = stubAi({
      whisper: (inputs) => {
        // base64 of RECORDING_BYTES — the recording reaches the model
        // input verbatim.
        expect(inputs.audio).toBe(btoa("\x01\x02\x03\x04\x05\x06\x07\x08"));
        return {
          text: "the save button does nothing when I click it",
          word_count: 9,
          vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nthe save button does nothing when I click it\n",
          transcription_info: {
            language: "en",
            language_probability: 0.99,
            duration: 2.1,
          },
          segments: [
            { start: 0, end: 2, text: "the save button does nothing" },
          ],
        };
      },
      summary: () => ({ response: "Save button unresponsive on checkout" }),
    });
    env.AI = stub.binding;

    const result = await transcribeCaptureRecording(db, env, {
      organizationId,
      ticketId: ticket.id,
      eventId,
      recordingR2Key,
      artifactPrefix,
      origin: ORIGIN,
      regenerateTitle: true,
    });
    expect(result.status).toBe("written");

    // R2 artifacts land under the same session prefix.
    for (const key of [
      `${artifactPrefix}/transcript/transcript.json`,
      `${artifactPrefix}/transcript/transcript.vtt`,
      `${artifactPrefix}/debugger_json/postprocessing.json`,
    ]) {
      expect(await env.ATTACHMENTS_BUCKET.get(key)).not.toBeNull();
    }

    const transcriptObject = await env.ATTACHMENTS_BUCKET.get(
      `${artifactPrefix}/transcript/transcript.json`
    );
    const transcriptJson = (await transcriptObject!.json()) as {
      text: string;
      language: string;
    };
    expect(transcriptJson.text).toBe(
      "the save button does nothing when I click it"
    );
    expect(transcriptJson.language).toBe("en");

    const attachments = await db
      .select()
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, ticket.id))
      .all();
    const transcriptRows = attachments.filter((a) => a.type === "transcript");
    expect(transcriptRows.map((r) => r.fileName).toSorted()).toEqual([
      "transcript.json",
      "transcript.vtt",
    ]);
    expect(
      attachments.some(
        (a) =>
          a.type === "debugger_json" && a.fileName === "postprocessing.json"
      )
    ).toBe(true);

    // Transcript text is readable straight off the ticket thread.
    const hydrated = await getTicketById(db, organizationId, ticket.id);
    expect(
      hydrated!.events.some((e) =>
        e.message?.textContent?.includes(
          "the save button does nothing when I click it"
        )
      )
    ).toBe(true);

    // Placeholder title replaced by the summary model.
    expect(hydrated!.title).toBe("Save button unresponsive on checkout");
    expect(stub.calls.map((c) => c.model)).toContain(SUMMARY_MODEL);
  });

  it("builds a VTT from segments when the model omits one and keeps a custom title", async () => {
    const { db, ticket, eventId, recordingR2Key, artifactPrefix } =
      await freshTicket();
    await db
      .update(supportTickets)
      .set({ title: "Reporter-chosen title" })
      .where(eq(supportTickets.id, ticket.id));

    const stub = stubAi({
      whisper: () => ({
        text: "first cue second cue",
        segments: [
          { start: 1.5, end: 3.25, text: "first cue" },
          { start: 3.5, end: 5, text: "second cue" },
        ],
      }),
      summary: () => {
        throw new Error("summary model must not run for custom titles");
      },
    });
    env.AI = stub.binding;

    const result = await transcribeCaptureRecording(db, env, {
      organizationId,
      ticketId: ticket.id,
      eventId,
      recordingR2Key,
      artifactPrefix,
      origin: ORIGIN,
      // Caller only passes regenerateTitle for placeholder titles — the
      // function still guards so a stray flag never clobbers a real one.
      regenerateTitle: false,
    });
    expect(result.status).toBe("written");

    const vttObject = await env.ATTACHMENTS_BUCKET.get(
      `${artifactPrefix}/transcript/transcript.vtt`
    );
    const vtt = await vttObject!.text();
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("00:00:01.500 --> 00:00:03.250");
    expect(vtt).toContain("first cue");
    expect(vtt).toContain("second cue");

    const hydrated = await getTicketById(db, organizationId, ticket.id);
    expect(hydrated!.title).toBe("Reporter-chosen title");
    expect(stub.calls.map((c) => c.model)).not.toContain(SUMMARY_MODEL);
  });

  it("skips cleanly when the AI binding is absent", async () => {
    const { db, ticket, eventId, recordingR2Key, artifactPrefix } =
      await freshTicket();
    const original = env.AI;
    try {
      env.AI = undefined;
      const result = await transcribeCaptureRecording(db, env, {
        organizationId,
        ticketId: ticket.id,
        eventId,
        recordingR2Key,
        artifactPrefix,
        origin: ORIGIN,
      });
      expect(result).toEqual({
        status: "skipped",
        reason: "ai-binding-missing",
      });
      expect(
        await env.ATTACHMENTS_BUCKET.get(
          `${artifactPrefix}/transcript/transcript.json`
        )
      ).toBeNull();
    } finally {
      env.AI = original;
    }
  });

  it("skips when the recording object is missing", async () => {
    const { db, ticket, eventId, artifactPrefix } = await freshTicket();
    env.AI = stubAi({}).binding;
    const result = await transcribeCaptureRecording(db, env, {
      organizationId,
      ticketId: ticket.id,
      eventId,
      recordingR2Key: `${organizationId}/capture/nope/video/missing.webm`,
      artifactPrefix,
      origin: ORIGIN,
    });
    expect(result).toEqual({ status: "skipped", reason: "recording-missing" });
  });

  it("returns failed and leaves the ticket intact when Whisper throws", async () => {
    const { db, ticket, eventId, recordingR2Key, artifactPrefix } =
      await freshTicket();
    env.AI = stubAi({
      whisper: () => {
        throw new Error("inference exploded");
      },
    }).binding;

    const result = await transcribeCaptureRecording(db, env, {
      organizationId,
      ticketId: ticket.id,
      eventId,
      recordingR2Key,
      artifactPrefix,
      origin: ORIGIN,
      regenerateTitle: true,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("inference exploded");
    }

    const attachments = await db
      .select()
      .from(supportTicketAttachments)
      .where(
        and(
          eq(supportTicketAttachments.ticketId, ticket.id),
          eq(supportTicketAttachments.type, "transcript")
        )
      )
      .all();
    expect(attachments).toEqual([]);

    const hydrated = await getTicketById(db, organizationId, ticket.id);
    expect(hydrated!.title).toBe("Bug report");
    expect(
      hydrated!.events.every(
        (e) => !e.message?.textContent?.includes("Transcript")
      )
    ).toBe(true);
  });

  it("writes artifacts but no message for an empty transcript", async () => {
    const { db, ticket, eventId, recordingR2Key, artifactPrefix } =
      await freshTicket();
    env.AI = stubAi({ whisper: () => ({ text: "", segments: [] }) }).binding;

    const result = await transcribeCaptureRecording(db, env, {
      organizationId,
      ticketId: ticket.id,
      eventId,
      recordingR2Key,
      artifactPrefix,
      origin: ORIGIN,
    });
    expect(result.status).toBe("written");
    if (result.status === "written") expect(result.text).toBe("");

    expect(
      await env.ATTACHMENTS_BUCKET.get(
        `${artifactPrefix}/transcript/transcript.json`
      )
    ).not.toBeNull();
    // No VTT artifact when the model yields no text or segments.
    expect(
      await env.ATTACHMENTS_BUCKET.get(
        `${artifactPrefix}/transcript/transcript.vtt`
      )
    ).toBeNull();

    const hydrated = await getTicketById(db, organizationId, ticket.id);
    expect(
      hydrated!.events.every((e) => e.subType !== "capture_transcript")
    ).toBe(true);
  });
});
