import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

import type { WorkerEnv } from "../platform/middleware.js";

interface D1Migration {
  name: string;
  queries: string[];
}

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.D1, env.TEST_MIGRATIONS);
});
