import { describe, expect, it } from "vitest";

import {
  getLaneDbProvider,
  laneDbConfigForRepo,
  PgxLaneDb,
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
    expect(provisioned.ref).toMatchObject({
      branch: "lane-sess-abc",
      roleId: "role-1",
    });
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

describe("PgxLaneDb (VTX-651)", () => {
  it("parses pgx repo config and provisions PILE_PGX_* + local DATABASE_URL", async () => {
    const metadata = {
      laneDb: {
        "VortexNYC/vortex": {
          provider: "pgx",
          template: "vortex_seeded",
          ttl: "4h",
          port: 5432,
        },
      },
    };
    const cfg = laneDbConfigForRepo(metadata, "VortexNYC/vortex");
    expect(cfg).toEqual({
      provider: "pgx",
      template: "vortex_seeded",
      ttl: "4h",
      port: 5432,
    });
    const provider = getLaneDbProvider({} as never, undefined, "pgx");
    expect(provider).toBeInstanceOf(PgxLaneDb);
    const provisioned = await provider!.provision(cfg!, "sess-1234-abcd");
    expect(provisioned.ref).toEqual({
      provider: "pgx",
      template: "vortex_seeded",
      branch: "lane_sess_1234_abcd",
      ttl: "4h",
    });
    expect(provisioned.env.PILE_PGX_TEMPLATE).toBe("vortex_seeded");
    expect(provisioned.env.PILE_PGX_BRANCH).toBe("lane_sess_1234_abcd");
    expect(provisioned.env.DATABASE_URL).toBe(
      "postgresql://postgres:postgres@127.0.0.1:5432/lane_sess_1234_abcd"
    );
  });
});
