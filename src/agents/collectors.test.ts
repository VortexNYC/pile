import { describe, expect, it, vi } from "vitest";

import {
  assertPublicHost,
  fetchPublic,
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

  it("rejects unspecified, IPv6-local, and IPv4-mapped addresses", () => {
    // WHATWG URL parsing normalizes the odd forms ("0", "0x0",
    // "127.1", "::ffff:" dotted tails) before the check sees them.
    for (const host of [
      "0.0.0.0",
      "0",
      "0x0",
      "127.1",
      "0177.0.0.1",
      "[::1]",
      "[::]",
      "[::ffff:127.0.0.1]",
      "[fe80::1]",
      "[fc00::1]",
      "[fd00::1]",
      "[ff02::1]",
      "[64:ff9b::7f00:1]",
    ]) {
      expect(() => assertPublicHost(host)).toThrow("public hosts");
    }
  });

  it("rejects non-default ports — a public host can still probe services", () => {
    for (const host of [
      "data.ny.gov:22",
      "https://data.ny.gov:8443/feed",
      "data.ny.gov@public.example:8080",
      "[2001:db8::1]:8080",
    ]) {
      expect(() => assertPublicHost(host)).toThrow("public hosts");
    }
    // The https default is the only port allowed.
    expect(() => assertPublicHost("data.ny.gov:443")).not.toThrow();
  });

  it("rejects CGNAT, benchmarking, documentation, and reserved ranges", () => {
    for (const host of [
      "100.64.0.1",
      "100.127.255.254",
      "198.18.0.1",
      "198.19.255.1",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "[2002:7f00:1::1]",
      "[2001::]",
      "[2001:0000:4136:e378:8000:63bf:3fff:fdd2]",
    ]) {
      expect(() => assertPublicHost(host)).toThrow("public hosts");
    }
    // Carve-outs that stay public — 100.63 is below CGNAT, 192.0.43 is
    // real unicast, 2001:4860 is global DNS.
    for (const host of [
      "100.63.255.1",
      "100.128.0.1",
      "192.0.43.10",
      "[2001:4860:4860::8888]",
    ]) {
      expect(() => assertPublicHost(host)).not.toThrow();
    }
  });

  it("allows public hosts — including f-leading domains and a public IPv6", () => {
    // `[[f]` used to be a character class blocking every f/F-leading
    // hostname; the bracketed-IPv6 alternative must not do that.
    for (const host of [
      "data.ny.gov",
      "foo.com",
      "fiscaldata.treasury.gov",
      "files.example.gov",
      "0.example.com",
      "[2001:db8::1]",
    ]) {
      expect(() => assertPublicHost(host)).not.toThrow();
    }
  });
});

describe("fetchPublic", () => {
  it("follows redirects while every hop host stays public", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.data.example/feed.json" },
        })
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await fetchPublic("https://data.example/feed.json");
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "https://cdn.data.example/feed.json"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a redirect into a blocked host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublic("https://data.example/feed.json")
      ).rejects.toThrow("public hosts");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a non-default port on the first URL and on redirect hops", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://data.example:22/feed.json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublic("https://data.example:22/feed.json")
      ).rejects.toThrow("public hosts");
      expect(fetchMock).not.toHaveBeenCalled();

      // Same guard on the redirect hop — the 302 target carries :22,
      // so hop two must die before its fetch goes out.
      await expect(
        fetchPublic("https://data.example/feed.json")
      ).rejects.toThrow("public hosts");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a redirect downgrading to http", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://data.example/feed.json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublic("https://data.example/feed.json")
      ).rejects.toThrow("public hosts");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops request headers once a redirect leaves the first origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.data.example/feed.json" },
        })
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchPublic("https://data.example/feed.json", {
        headers: { "X-App-Token": "secret-token" },
      });
      const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
      expect(first.headers).toEqual({ "X-App-Token": "secret-token" });
      expect(second.headers).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives up once the redirect cap is hit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://data.example/loop" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        fetchPublic("https://data.example/loop", undefined, 2)
      ).rejects.toThrow("too many redirects");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("refuses a public feed domain that redirects into a private host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(pullSource(socrataSource())).rejects.toThrow("public hosts");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
