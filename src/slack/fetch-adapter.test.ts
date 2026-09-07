import { afterEach, describe, expect, it, vi } from "vitest";

import { SlackFetchAdapterError, workerdFetchAdapter } from "./fetch-adapter.js";

type AdapterConfig = Parameters<typeof workerdFetchAdapter>[0];

function config(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    url: "oauth.v2.access",
    baseURL: "https://slack.com/api/",
    method: "post",
    headers: {},
    data: "client_id=x&code=y",
    ...overrides,
  } as AdapterConfig;
}

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("workerdFetchAdapter", () => {
  it("sends no cache option and returns axios-shaped response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, access_token: "xoxb-t" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await workerdFetchAdapter(config());

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(request.method).toBe("POST");
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ ok: true, access_token: "xoxb-t" });
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.config.url).toBe("oauth.v2.access");
  });

  it("appends query params", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await workerdFetchAdapter(
      config({ params: { channel: "C123", limit: 2 } })
    );
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toContain("channel=C123");
    expect(request.url).toContain("limit=2");
  });

  it("rejects with axios-shaped error on non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "30" },
      })
    );

    const error = await workerdFetchAdapter(config()).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(SlackFetchAdapterError);
    const axiosError = error as SlackFetchAdapterError;
    expect(axiosError.isAxiosError).toBe(true);
    expect(axiosError.response?.status).toBe(429);
    expect(axiosError.response?.headers["retry-after"]).toBe("30");
  });

  it("rejects ERR_NETWORK when fetch throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = await workerdFetchAdapter(config()).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(SlackFetchAdapterError);
    expect((error as SlackFetchAdapterError).code).toBe("ERR_NETWORK");
  });

  it("serializes JSON bodies with content-type", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await workerdFetchAdapter(
      config({ data: { channel: "C1", text: "hi" }, method: "post" })
    );
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe('{"channel":"C1","text":"hi"}');
  });

  it("respects a custom validateStatus", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    const result = await workerdFetchAdapter(
      config({ validateStatus: () => true })
    );
    expect(result.status).toBe(404);
  });
});
