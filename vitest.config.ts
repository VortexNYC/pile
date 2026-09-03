import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = path.join(import.meta.dirname ?? ".", "migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TOKEN_HASH_SECRET: "test-token-hash-secret-do-not-use-in-prod",
          BETTER_AUTH_SECRET: "test-better-auth-secret-do-not-use-in-prod",
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ["./src/test/apply-migrations.ts"],
  },
});
