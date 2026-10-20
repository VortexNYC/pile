import { describe, expect, it, vi } from "vitest";

import {
  assertPublicHost,
  pullSource,
  scoreCandidate,
  type MerchantCandidate,
  type MerchantSourceRow,
} from "./collectors.js";

const base: MerchantCandidate = {
  name: "Test Co",
  externalId: "test:1",
  signal: "registration",
  signalDate: null,
};

describe("scoreCandidate", () => {
  it("ranks license_pending above registration", () => {
    const today = new Date().toISOString();
    const pending = scoreCandidate({
      ...base,
      signal: "license_pending",
      signalDate: today,
    });
    const reg = scoreCandidate({ ...base, signalDate: today });
    expect(pending).toBeGreaterThan(reg);
  });

  it("decays stale signals — a filing this week outranks last quarter", () => {
    const fresh = scoreCandidate({
      ...base,
      signal: "corp_filing",
      signalDate: new Date(Date.now() - 86400000).toISOString(),
    });
    const stale = scoreCandidate({
      ...base,
      signal: "corp_filing",
      signalDate: new Date(Date.now() - 90 * 86400000).toISOString(),
    });
    expect(fresh).toBeGreaterThan(stale);
  });

  it("unknown signals get a base weight and still decay", () => {
    const score = scoreCandidate({
      ...base,
      signal: "weird_signal",
      signalDate: new Date().toISOString(),
    });
    expect(score).toBeLessThanOrEqual(0.4);
    expect(score).toBeGreaterThan(0);
    const ancient = scoreCandidate({ ...base, signal: "weird_signal" });
    expect(ancient).toBe(0);
  });
});

function socrataSource(
  overrides: Partial<MerchantSourceRow> = {}
): MerchantSourceRow {
  return {
    id: "src-1",
    name: "test-feed",
    kind: "socrata",
    config: JSON.stringify({ domain: "data.ny.gov", dataset: "abc-123" }),
    cursorField: null,
    cursorValue: null,
    signal: "license_pending",
    runCount: 0,
    ...overrides,
  };
}

describe("assertPublicHost", () => {
  it("rejects loopback, private, and userinfo-disguised hosts", () => {
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "localhost",
      "data.ny.gov@127.0.0.1",
    ]) {
      expect(() => assertPublicHost(host)).toThrow("public hosts");
    }
    expect(() => assertPublicHost("data.ny.gov")).not.toThrow();
  });
});

describe("pullSource socrata", () => {
  it("refuses a lane-configured private feed domain", async () => {
    const source = socrataSource({
      config: JSON.stringify({
        domain: "169.254.169.254",
        dataset: "abc-123",
      }),
    });
    await expect(pullSource(source)).rejects.toThrow("public hosts");
  });

  it("escapes a stored cursor value inside the $where literal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await pullSource(
        socrataSource({
          cursorField: "received_date",
          cursorValue: "2026-01-01' OR '1'='1",
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
    const url = String(fetchMock.mock.calls[0]?.[0]);
    const where = new URL(url).searchParams.get("$where") ?? "";
    expect(where).toBe("received_date > '2026-01-01'' OR ''1''=''1'");
  });

  it("rejects a cursor field that is not a plain identifier", async () => {
    await expect(
      pullSource(
        socrataSource({
          cursorField: "received_date) OR (1=1",
          cursorValue: null,
        })
      )
    ).rejects.toThrow("identifier");
    await expect(
      pullSource(socrataSource({ cursorField: "x; DROP", cursorValue: null }))
    ).rejects.toThrow("identifier");
  });
});
