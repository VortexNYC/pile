import path from "node:path";

import { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const migrationsPath = path.join(import.meta.dirname ?? ".", "migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineWorkersConfig({
  test: {
    globals: true,
    setupFiles: ["./src/test/apply-migrations.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TOKEN_HASH_SECRET: "test-token-hash-secret-do-not-use-in-prod",
          },
        },
      },
    },
  },
});
