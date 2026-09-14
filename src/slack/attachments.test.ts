import { describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../platform/middleware.js";
import { captureSlackAttachments } from "./attachments.js";

function makeEnv(bucket?: { put: ReturnType<typeof vi.fn> }): WorkerEnv {
  const createAttachment = vi.fn().mockResolvedValue(undefined);
  const setOrganizationId = vi.fn().mockResolvedValue(undefined);
  const stub = {
    setOrganizationId,
    createAttachment,
  } as unknown as ReturnType<WorkerEnv["WORKSPACE_DURABLE_OBJECT"]["get"]>;

  const namespace = {
    idFromName: vi.fn(() => "do-id" as unknown as DurableObjectId),
    get: vi.fn(() => stub),
  } as unknown as WorkerEnv["WORKSPACE_DURABLE_OBJECT"];

  const env = {
    WORKSPACE_DURABLE_OBJECT: namespace,
  } as unknown as WorkerEnv;

  if (bucket) {
    (env as unknown as Record<string, unknown>).ATTACHMENTS_BUCKET =
      bucket as unknown as WorkerEnv["ATTACHMENTS_BUCKET"];
  }

  return env;
}

function stubBucket() {
  return { put: vi.fn().mockResolvedValue(undefined) };
}

describe("captureSlackAttachments", () => {
  it("returns early when there are no attachments", async () => {
    const env = makeEnv();

    await captureSlackAttachments(env, "org-1", "ISS-1", {
      attachments: [],
      raw: { files: [] },
    });

    expect(env.WORKSPACE_DURABLE_OBJECT.get).not.toHaveBeenCalled();
  });

  it("records each attachment in the workspace DO", async () => {
    const env = makeEnv();

    await captureSlackAttachments(env, "org-1", "ISS-1", {
      attachments: [
        { url: "https://files.slack/1", name: "a.png", mimeType: "image/png" },
        { url: "https://files.slack/2", name: "b.txt", mimeType: "text/plain" },
      ],
      raw: { files: [{ id: "F1" }, { id: "F2" }] },
    });

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      "do-id" as unknown as DurableObjectId
    ) as unknown as { createAttachment: ReturnType<typeof vi.fn> };

    expect(env.WORKSPACE_DURABLE_OBJECT.idFromName).toHaveBeenCalledWith(
      "org-1"
    );
    expect(stub.createAttachment).toHaveBeenCalledTimes(2);
    expect(stub.createAttachment).toHaveBeenNthCalledWith(1, {
      issueId: "ISS-1",
      linearId: "F1",
      url: "https://files.slack/1",
      title: "a.png",
      subtitle: "image/png",
      r2Key: null,
    });
    expect(stub.createAttachment).toHaveBeenNthCalledWith(2, {
      issueId: "ISS-1",
      linearId: "F2",
      url: "https://files.slack/2",
      title: "b.txt",
      subtitle: "text/plain",
      r2Key: null,
    });
  });

  it("uploads data to R2 and records the r2Key when a bucket is bound", async () => {
    const bucket = stubBucket();
    const env = makeEnv(bucket);
    const data = new ArrayBuffer(8);

    await captureSlackAttachments(env, "org-1", "ISS-1", {
      attachments: [
        {
          url: "https://files.slack/F123",
          name: "screenshot.png",
          mimeType: "image/png",
          fetchData: async () => data,
        },
      ],
      raw: { files: [{ id: "F123" }] },
    });

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      "do-id" as unknown as DurableObjectId
    ) as unknown as { createAttachment: ReturnType<typeof vi.fn> };

    expect(bucket.put).toHaveBeenCalledWith(
      "attachments/org-1/ISS-1/F123",
      data,
      {
        httpMetadata: {
          contentType: "image/png",
          contentDisposition: 'attachment; filename="screenshot.png"',
        },
      }
    );
    expect(stub.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        r2Key: "attachments/org-1/ISS-1/F123",
      })
    );
  });

  it("keeps metadata when fetchData fails", async () => {
    const bucket = stubBucket();
    const env = makeEnv(bucket);

    await captureSlackAttachments(env, "org-1", "ISS-1", {
      attachments: [
        {
          url: "https://files.slack/FAIL",
          name: "bad.bin",
          mimeType: "application/octet-stream",
          fetchData: async () => {
            throw new Error("download failed");
          },
        },
      ],
      raw: { files: [{ id: "FAIL" }] },
    });

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      "do-id" as unknown as DurableObjectId
    ) as unknown as { createAttachment: ReturnType<typeof vi.fn> };

    expect(bucket.put).not.toHaveBeenCalled();
    expect(stub.createAttachment).toHaveBeenCalledWith({
      issueId: "ISS-1",
      linearId: "FAIL",
      url: "https://files.slack/FAIL",
      title: "bad.bin",
      subtitle: "application/octet-stream",
      r2Key: null,
    });
  });

  it("falls back to unknown ids when raw.files is missing", async () => {
    const env = makeEnv();

    await captureSlackAttachments(env, "org-1", "ISS-1", {
      attachments: [{ url: "https://files.slack/x" }],
      raw: {},
    });

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      "do-id" as unknown as DurableObjectId
    ) as unknown as { createAttachment: ReturnType<typeof vi.fn> };

    expect(stub.createAttachment).toHaveBeenCalledWith({
      issueId: "ISS-1",
      linearId: "unknown-0",
      url: "https://files.slack/x",
      title: null,
      subtitle: null,
      r2Key: null,
    });
  });
});
