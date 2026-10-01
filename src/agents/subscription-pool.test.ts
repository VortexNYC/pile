import { describe, expect, it } from "vitest";

import {
  parseCredentialPool,
  poolHealth,
  probeSubscriptionCredential,
  redactCredentialPool,
  selectPoolCredential,
  type CredentialPoolEntry,
} from "./subscription-pool.js";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const HOUR = 3_600_000;

function enc(v: unknown): string {
  return btoa(JSON.stringify(v))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function jwt(expMs: number): string {
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function codexAuth(expMs: number, refresh = true): string {
  return btoa(
    JSON.stringify({
      tokens: {
        access_token: jwt(expMs),
        ...(refresh ? { refresh_token: "rt" } : {}),
      },
    })
  );
}

function claudeCreds(expMs: number, refresh = true): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-a",
      expiresAt: expMs,
      ...(refresh ? { refreshToken: "sk-ant-ort01-r" } : {}),
    },
  });
}

describe("parseCredentialPool", () => {
  it("returns null for unset or empty pools", () => {
    expect(parseCredentialPool(undefined)).toBeNull();
    expect(parseCredentialPool("  ")).toBeNull();
    expect(parseCredentialPool("[]")).toBeNull();
  });

  it("rejects malformed JSON and unknown kinds", () => {
    expect(() => parseCredentialPool("{")).toThrow(/not valid JSON/);
    expect(() =>
      parseCredentialPool(JSON.stringify([{ kind: "nope", secret: "x" }]))
    ).toThrow(/AGENT_CREDENTIAL_POOL is invalid/);
  });

  it("parses ordered entries", () => {
    const pool = parseCredentialPool(
      JSON.stringify([
        { kind: "claudeSubscription", secret: "sk-ant-oat01-x", label: "max" },
        { kind: "anthropicApiKey", secret: "sk-ant-api03-y" },
      ])
    );
    expect(pool?.map((e) => e.kind)).toEqual([
      "claudeSubscription",
      "anthropicApiKey",
    ]);
  });
});

describe("probeSubscriptionCredential", () => {
  it("accepts long-lived claude setup-token tokens", () => {
    expect(
      probeSubscriptionCredential(
        { kind: "claudeSubscription", secret: "sk-ant-oat01-x" },
        NOW
      ).status
    ).toBe("ok");
  });

  it("flags API keys stored as subscriptions", () => {
    expect(
      probeSubscriptionCredential(
        { kind: "claudeSubscription", secret: "sk-ant-api03-x" },
        NOW
      ).status
    ).toBe("invalid");
  });

  it("reads claude credentials.json expiry (raw or base64)", () => {
    const live = claudeCreds(NOW + HOUR);
    expect(
      probeSubscriptionCredential(
        { kind: "claudeSubscription", secret: live },
        NOW
      )
    ).toMatchObject({ status: "ok", expiresAt: "2026-10-01T01:00:00.000Z" });
    expect(
      probeSubscriptionCredential(
        { kind: "claudeSubscription", secret: btoa(claudeCreds(NOW - HOUR)) },
        NOW
      ).status
    ).toBe("refreshable");
    expect(
      probeSubscriptionCredential(
        {
          kind: "claudeSubscription",
          secret: claudeCreds(NOW - HOUR, false),
        },
        NOW
      ).status
    ).toBe("expired");
  });

  it("codexRefreshDetect: decodes the access-token JWT exp", () => {
    expect(
      probeSubscriptionCredential(
        { kind: "codexOAuth", secret: codexAuth(NOW + HOUR) },
        NOW
      ).status
    ).toBe("ok");
    expect(
      probeSubscriptionCredential(
        { kind: "codexOAuth", secret: codexAuth(NOW + 30_000) },
        NOW
      ).status
    ).toBe("refreshable");
    expect(
      probeSubscriptionCredential(
        { kind: "codexOAuth", secret: codexAuth(NOW - HOUR, false) },
        NOW
      ).status
    ).toBe("expired");
  });

  it("rejects API-key-mode codex auth.json", () => {
    expect(
      probeSubscriptionCredential(
        {
          kind: "codexOAuth",
          secret: JSON.stringify({ OPENAI_API_KEY: "sk-x" }),
        },
        NOW
      )
    ).toMatchObject({ status: "invalid", message: /API-key mode/ });
  });

  it("reads gemini oauth_creds.json expiry_date", () => {
    expect(
      probeSubscriptionCredential(
        {
          kind: "geminiOAuth",
          secret: JSON.stringify({
            access_token: "ya29",
            refresh_token: "1//r",
            expiry_date: NOW - HOUR,
          }),
        },
        NOW
      ).status
    ).toBe("refreshable");
  });
});

describe("selectPoolCredential", () => {
  const pool: CredentialPoolEntry[] = [
    {
      kind: "claudeSubscription",
      secret: claudeCreds(NOW - HOUR, false),
      label: "max-expired",
    },
    {
      kind: "claudeSubscription",
      secret: "sk-ant-oat01-review",
      label: "max-review",
      purposes: ["review", "triage"],
    },
    { kind: "codexOAuth", secret: codexAuth(NOW + HOUR), label: "codex" },
    { kind: "anthropicApiKey", secret: "sk-ant-api03-k", label: "api" },
  ];
  const kinds = ["claudeSubscription", "anthropicApiKey"] as const;

  it("falls through dead and purpose-scoped entries in order", () => {
    const selection = selectPoolCredential(pool, { kinds, now: NOW });
    expect(selection.label).toBe("api");
    expect(selection.skipped.map((s) => [s.label, s.status])).toEqual([
      ["max-expired", "expired"],
      ["max-review", "purpose-mismatch"],
    ]);
  });

  it("uses the subscription entry for matching lane purposes", () => {
    const selection = selectPoolCredential(pool, {
      kinds,
      purpose: "review",
      now: NOW,
    });
    expect(selection.label).toBe("max-review");
    expect(selection.entry.secret).toBe("sk-ant-oat01-review");
  });

  it("only considers kinds the provider consumes", () => {
    expect(
      selectPoolCredential(pool, { kinds: ["codexOAuth"], now: NOW }).label
    ).toBe("codex");
  });

  it("throws with every candidate's reason when exhausted", () => {
    expect(() =>
      selectPoolCredential(pool.slice(0, 2), { kinds, now: NOW })
    ).toThrow(/max-expired .*expired.*max-review .*purpose-mismatch/);
    expect(() =>
      selectPoolCredential(pool, { kinds: ["geminiOAuth"], now: NOW })
    ).toThrow(/no geminiOAuth entries/);
  });
});

describe("poolHealth", () => {
  it("is ok when any entry is usable and reports expiries", () => {
    const health = poolHealth(
      [
        { kind: "codexOAuth", secret: codexAuth(NOW - HOUR, false) },
        { kind: "codexOAuth", secret: codexAuth(NOW + HOUR), label: "b" },
      ],
      ["codexOAuth"],
      NOW
    );
    expect(health.ok).toBe(true);
    expect(health.message).toContain("codexOAuth#0 (codexOAuth): expired");
    expect(health.message).toContain("expires 2026-10-01T01:00:00.000Z");
  });

  it("is not ok when every entry is dead", () => {
    expect(
      poolHealth(
        [{ kind: "codexOAuth", secret: "garbage" }],
        ["codexOAuth"],
        NOW
      ).ok
    ).toBe(false);
  });
});

describe("redactCredentialPool", () => {
  it("drops secrets", () => {
    const redacted = redactCredentialPool([
      { kind: "claudeSubscription", secret: "sk-ant-oat01-x", label: "max" },
    ]);
    expect(redacted).toEqual([
      { kind: "claudeSubscription", label: "max", purposes: undefined },
    ]);
    expect(JSON.stringify(redacted)).not.toContain("sk-ant");
    expect(redactCredentialPool("not-a-pool")).toBeNull();
  });
});
