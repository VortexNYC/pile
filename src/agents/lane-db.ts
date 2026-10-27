import type { WorkerEnv } from "../platform/middleware.js";

// PILE-212 — lane-scoped preview databases. Layer 1 (default) is the in-image
// local Postgres — every lane already has postgresql://postgres:postgres@
// 127.0.0.1:5432/vortex_dev and needs no provisioning. Layer 2 provisions a
// PlanetScale branch + scoped role for lanes whose repo declares `laneDb` in
// org metadata (organization.metadata.laneDb["owner/name"]). pgrun (Layer 3)
// plugs into the same interface later if prod-shaped rehearsal is ever needed.

export interface PlanetScaleLaneDbConfig {
  provider: "planetscale";
  org: string;
  database: string;
  baseBranch: string;
}

export interface PgxLaneDbConfig {
  provider: "pgx";
  template: string;
  ttl?: string;
  port?: number;
}

export type LaneDbConfig = PlanetScaleLaneDbConfig | PgxLaneDbConfig;

export interface PlanetScaleLaneDbRef {
  provider: "planetscale";
  org: string;
  database: string;
  branch: string;
  roleId: string;
}

export interface PgxLaneDbRef {
  provider: "pgx";
  template: string;
  branch: string;
  ttl: string;
}

export type LaneDbRef = PlanetScaleLaneDbRef | PgxLaneDbRef;

export interface LaneDbProvision {
  /** Serialized into agent_sessions.lane_db_ref for the teardown/reaper. */
  ref: LaneDbRef;
  /** Injected into the runner env — connection strings never hit logs. */
  env: Record<string, string>;
}

export interface LaneDbProvider {
  name: string;
  provision(config: LaneDbConfig, sessionId: string): Promise<LaneDbProvision>;
  teardown(ref: LaneDbRef): Promise<void>;
}

/** Repo-level laneDb config lives in organization.metadata.laneDb keyed by
 *  "owner/name" — avoids a schema change and keeps the per-repo opt-in in one
 *  place. Absent = local in-image Postgres (Layer 1). */
export function laneDbConfigForRepo(
  orgMetadata: Record<string, unknown> | null,
  repo: string | null | undefined
): LaneDbConfig | null {
  if (!repo || !orgMetadata) return null;
  const table = orgMetadata.laneDb;
  if (typeof table !== "object" || table === null) return null;
  const entry = (table as Record<string, unknown>)[repo];
  if (typeof entry !== "object" || entry === null) return null;
  const cfg = entry as Record<string, unknown>;
  if (
    cfg.provider === "pgx" &&
    typeof cfg.template === "string" &&
    cfg.template.trim().length > 0
  ) {
    return {
      provider: "pgx",
      template: cfg.template.trim(),
      ...(typeof cfg.ttl === "string" ? { ttl: cfg.ttl } : {}),
      ...(typeof cfg.port === "number" ? { port: cfg.port } : {}),
    };
  }
  if (
    cfg.provider !== "planetscale" ||
    typeof cfg.org !== "string" ||
    typeof cfg.database !== "string" ||
    typeof cfg.baseBranch !== "string"
  ) {
    return null;
  }
  return {
    provider: "planetscale",
    org: cfg.org,
    database: cfg.database,
    baseBranch: cfg.baseBranch,
  };
}

interface PscaleRoleResponse {
  id?: string;
  username?: string;
  password?: string;
  host?: string;
}

export class PlanetScaleLaneDb implements LaneDbProvider {
  name = "planetscale";
  constructor(
    private readonly token: string,
    private readonly ghFetch: typeof fetch = fetch
  ) {}

  private async api(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.ghFetch(`https://api.planetscale.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(
        `planetscale ${init?.method ?? "GET"} ${path} -> ${res.status}`
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async provision(
    config: LaneDbConfig,
    sessionId: string
  ): Promise<LaneDbProvision> {
    if (config.provider !== "planetscale") {
      throw new Error(`PlanetScaleLaneDb cannot provision ${config.provider}`);
    }
    const branch = `lane-${sessionId.replaceAll(/[^a-z0-9-]/g, "").slice(0, 20)}`;
    const dbPath = `/organizations/${config.org}/databases/${config.database}`;
    await this.api(`${dbPath}/branches`, {
      method: "POST",
      body: JSON.stringify({ name: branch, parent_branch: config.baseBranch }),
    });
    const role = (await this.api(`${dbPath}/branches/${branch}/roles`, {
      method: "POST",
      // Read-write on the lane branch only; expires with teardown.
      body: JSON.stringify({ inherited_branch_roles: ["read_write"] }),
    })) as PscaleRoleResponse;
    if (!role.id || !role.username || !role.password || !role.host) {
      throw new Error("planetscale role response missing credentials");
    }
    const url = `postgresql://${role.username}:${role.password}@${role.host}/${config.database}?sslaccept=strict`;
    return {
      ref: {
        provider: "planetscale",
        org: config.org,
        database: config.database,
        branch,
        roleId: role.id,
      },
      env: {
        TEST_DATABASE_URL: url,
        DATABASE_URL: url,
        PAYMENTS_STORAGE_ALLOW_REMOTE: "1",
      },
    };
  }

  async teardown(ref: LaneDbRef): Promise<void> {
    if (ref.provider !== "planetscale") return;
    const dbPath = `/organizations/${ref.org}/databases/${ref.database}`;
    await this.api(`${dbPath}/branches/${ref.branch}/roles/${ref.roleId}`, {
      method: "DELETE",
    }).catch(() => {});
    await this.api(`${dbPath}/branches/${ref.branch}`, {
      method: "DELETE",
    }).catch(() => {});
  }
}

/** VTX-651 — pgrundev/pgx copy-on-write Postgres branching (~6ms warm clone).
 *  Injects PILE_PGX_TEMPLATE / PILE_PGX_BRANCH / PILE_PGX_TTL into the lane
 *  environment so `ensure_postgres()` in `core.py` runs
 *  `pgx clone <template> <branch> --ttl <ttl>` inside the sandbox. */
export class PgxLaneDb implements LaneDbProvider {
  name = "pgx";

  async provision(
    config: LaneDbConfig,
    sessionId: string
  ): Promise<LaneDbProvision> {
    if (config.provider !== "pgx") {
      throw new Error(`PgxLaneDb cannot provision ${config.provider}`);
    }
    const branch = `lane_${sessionId
      .toLowerCase()
      .replaceAll(/[^a-z0-9_]/g, "_")
      .slice(0, 24)}`;
    const ttl = config.ttl ?? "3h";
    const port = config.port ?? 5432;
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/${branch}`;
    return {
      ref: {
        provider: "pgx",
        template: config.template,
        branch,
        ttl,
      },
      env: {
        PILE_PGX_TEMPLATE: config.template,
        PILE_PGX_BRANCH: branch,
        PILE_PGX_TTL: ttl,
        TEST_DATABASE_URL: url,
        DATABASE_URL: url,
      },
    };
  }

  async teardown(_ref: LaneDbRef): Promise<void> {
    // pgx clones auto-expire on `--ttl` and are torn down with the sandbox.
  }
}

/** Provider selection: PgxLaneDb when the repo/ref specifies `pgx`, else
 *  PlanetScale when the worker carries `PSCALE_SERVICE_TOKEN`, else null
 *  (Layer 1 local pg — the in-image default). */
export function getLaneDbProvider(
  env: WorkerEnv,
  ghFetch?: typeof fetch,
  providerHint?: "planetscale" | "pgx"
): LaneDbProvider | null {
  if (providerHint === "pgx") return new PgxLaneDb();
  const token = env.PSCALE_SERVICE_TOKEN;
  if (typeof token !== "string" || token.length === 0) return null;
  return new PlanetScaleLaneDb(token, ghFetch);
}
