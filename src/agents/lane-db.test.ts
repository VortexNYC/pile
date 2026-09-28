import { describe, expect, it } from "vitest";

import {
  laneDbConfigForRepo,
  PlanetScaleLaneDb,
  type LaneDbRef,
} from "./lane-db.js";

describe("laneDbConfigForRepo", () => {
  const cfg = {
    provider: "planetscale",
    org: "acme",
    database: "vortex",
    baseBranch: "main",
  };

  it("returns the config for a repo declared in org metadata", () => {
    const metadata = { laneDb: { "acme/widgets": cfg } };
    expect(laneDbConfigForRepo(metadata, "acme/widgets")).toEqual(cfg);
  });

  it("returns null when absent, malformed, or unconfigured", () => {
    expect(laneDbConfigForRepo(null, "acme/widgets")).toBeNull();
    expect(laneDbConfigForRepo({}, "acme/widgets")).toBeNull();
    expect(laneDbConfigForRepo({ laneDb: {} }, "acme/widgets")).toBeNull();
    expect(laneDbConfigForRepo(null, null)).toBeNull();
    expect(
      laneDbConfigForRepo(
        { laneDb: { "acme/widgets": { provider: "pg" } } },
        "acme/widgets"
      )
    ).toBeNull();
  });
});

describe("PlanetScaleLaneDb", () => {
  it("provisions branch + role and returns injected env", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fakeFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/branches")) {
        return new Response(JSON.stringify({ name: "lane-s1" }), {
          status: 201,
        });
      }
      if (url.endsWith("/roles")) {
        return new Response(
          JSON.stringify({
            id: "role-1",
            username: "u.lane",
            password: "p.lane",
            host: "lane.connect.psdb.cloud",
          }),
          { status: 201 }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const provider = new PlanetScaleLaneDb("svc-token", fakeFetch);
    const provisioned = await provider.provision(
      {
        provider: "planetscale",
        org: "acme",
        database: "vortex",
        baseBranch: "main",
      },
      "sess-abc"
    );

    expect(calls[0].url).toBe(
      "https://api.planetscale.com/v1/organizations/acme/databases/vortex/branches"
    );
    expect(calls[0].body).toEqual({
      name: "lane-sess-abc",
      parent_branch: "main",
    });
    expect(calls[1].url).toContain("/branches/lane-sess-abc/roles");
    expect(provisioned.env.TEST_DATABASE_URL).toContain(
      "lane.connect.psdb.cloud"
    );
    expect(provisioned.env.PAYMENTS_STORAGE_ALLOW_REMOTE).toBe("1");
    expect(provisioned.ref.branch).toBe("lane-sess-abc");
    expect(provisioned.ref.roleId).toBe("role-1");
  });

  it("teardown deletes the role then the branch", async () => {
    const deleted: string[] = [];
    const fakeFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      if (init?.method === "DELETE") deleted.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const provider = new PlanetScaleLaneDb("svc-token", fakeFetch);
    const ref: LaneDbRef = {
      provider: "planetscale",
      org: "acme",
      database: "vortex",
      branch: "lane-s1",
      roleId: "role-1",
    };
    await provider.teardown(ref);
    expect(deleted[0]).toContain("/branches/lane-s1/roles/role-1");
    expect(deleted[1]).toContain("/branches/lane-s1");
  });
});
