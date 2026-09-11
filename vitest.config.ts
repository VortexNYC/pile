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
          SLACK_CLIENT_ID: "test-slack-client-id",
          SLACK_CLIENT_SECRET: "test-slack-client-secret",
          SLACK_SIGNING_SECRET: "test-slack-signing-secret",
          SLACK_ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          SLACK_REDIRECT_URI: "http://localhost/slack/oauth",
          INTERCOM_CLIENT_SECRET: "test-intercom-client-secret",
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ["./src/test/apply-migrations.ts"],
  },
});
