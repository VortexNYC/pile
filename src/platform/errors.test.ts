import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { errorCodeFromStatus, toErrorResponse, VortexError } from "./errors.js";

describe("errorCodeFromStatus", () => {
  it("maps catalog statuses to stable codes", () => {
    expect(errorCodeFromStatus(400)).toBe("BAD_REQUEST");
    expect(errorCodeFromStatus(401)).toBe("UNAUTHORIZED");
    expect(errorCodeFromStatus(402)).toBe("USAGE_LIMIT");
    expect(errorCodeFromStatus(403)).toBe("FORBIDDEN");
    expect(errorCodeFromStatus(404)).toBe("NOT_FOUND");
    expect(errorCodeFromStatus(409)).toBe("CONFLICT");
    expect(errorCodeFromStatus(422)).toBe("UNPROCESSABLE_CONTENT");
    expect(errorCodeFromStatus(429)).toBe("TOO_MANY_REQUESTS");
    expect(errorCodeFromStatus(502)).toBe("AGENT_ERROR");
    expect(errorCodeFromStatus(500)).toBe("INTERNAL_ERROR");
  });

  it("falls back by status class", () => {
    expect(errorCodeFromStatus(418)).toBe("BAD_REQUEST");
    expect(errorCodeFromStatus(503)).toBe("INTERNAL_ERROR");
  });
});

describe("toErrorResponse", () => {
  it("preserves VortexError code, status, and hint", async () => {
    const res = toErrorResponse(
      new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
        hint: "ISS-1",
      })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("NOT_FOUND");
    await expect(res.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "Issue not found",
      hint: "ISS-1",
    });
  });

  it("maps HTTPException status onto catalog codes", async () => {
    const res = toErrorResponse(new HTTPException(404, { message: "gone" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("NOT_FOUND");
    await expect(res.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "gone",
    });
  });

  it("redacts 5xx HTTPException text from the wire and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = toErrorResponse(
      new HTTPException(503, { message: "upstream secret leaked" })
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("INTERNAL_ERROR");
    await expect(res.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal error",
    });
    expect(error).toHaveBeenCalledWith("unhandled HTTPException", {
      status: 503,
      message: "upstream secret leaked",
    });
    error.mockRestore();
  });

  it("maps ZodError to BAD_REQUEST with a validation hint", async () => {
    const parsed = z.object({ id: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const res = toErrorResponse(parsed.error);
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("BAD_REQUEST");
    const body = (await res.json()) as { hint?: string };
    expect(body.hint).toBeTruthy();
  });

  it("rebuilds a VortexError serialized across the DO RPC boundary", async () => {
    // Thrown inside a Durable Object, a VortexError arrives as a plain Error
    // carrying its own enumerable properties — simulate that shape.
    const serialized = Object.assign(new Error("Conflict"), {
      code: "CONFLICT",
      status: 409,
      hint: "Issue ISS-1 already uses repo owner/repo and branch feat",
      details: undefined,
      remote: true,
    });
    const res = toErrorResponse(serialized);
    expect(res.status).toBe(409);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("CONFLICT");
    await expect(res.json()).resolves.toEqual({
      code: "CONFLICT",
      message: "Conflict",
      hint: "Issue ISS-1 already uses repo owner/repo and branch feat",
    });
  });

  it("redacts messages on serialized 5xx VortexErrors", async () => {
    const serialized = Object.assign(new Error("d1 connection details"), {
      code: "CONFIG_ERROR",
      status: 500,
    });
    const res = toErrorResponse(serialized);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      code: "CONFIG_ERROR",
      message: "Configuration error",
    });
  });

  it("ignores errors whose code is not in the catalog", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const serialized = Object.assign(new Error("nope"), {
      code: "ENOENT",
      status: 404,
    });
    const res = toErrorResponse(serialized);
    expect(res.status).toBe(500);
    error.mockRestore();
  });

  it("does not leak unexpected Error messages to clients", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = toErrorResponse(new Error("db password expired"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Pile-Error-Code")).toBe("INTERNAL_ERROR");
    await expect(res.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal error",
    });
    expect(error).toHaveBeenCalledWith("unhandled error", {
      message: "db password expired",
    });
    error.mockRestore();
  });
});
