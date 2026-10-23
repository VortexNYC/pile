import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const migrationsPath = path.join(import.meta.dirname ?? ".", "migrations");
const migrations = await readD1Migrations(migrationsPath);
const webSrcPath = path.join(import.meta.dirname ?? ".", "apps/web/src");

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "@": webSrcPath,
          },
        },
        plugins: [
          cloudflareTest({
            // wrangler.test.toml is wrangler.toml minus the sandbox-sdk 1.0
            // `durable_object` container entries — the pool's bundled
            // wrangler predates that schema and would reject the parse.
            wrangler: { configPath: "./wrangler.test.toml" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                TOKEN_HASH_SECRET: "test-token-hash-secret-do-not-use-in-prod",
                BETTER_AUTH_SECRET:
                  "test-better-auth-secret-do-not-use-in-prod",
                SLACK_CLIENT_ID: "test-slack-client-id",
                SLACK_CLIENT_SECRET: "test-slack-client-secret",
                SLACK_SIGNING_SECRET: "test-slack-signing-secret",
                SLACK_ENCRYPTION_KEY:
                  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                SLACK_REDIRECT_URI: "http://localhost/slack/oauth",
                INTERCOM_CLIENT_SECRET: "test-intercom-client-secret",
                FEEDBACK_CHANNEL_ID: "test-feedback-channel",
                BILLING_WEBHOOK_SECRET:
                  "test-billing-webhook-secret-do-not-use",
                FREE_USE_CAP: "0",
              },
            },
          }),
        ],
        test: {
          name: "workerd",
          // Playwright specs live under packages/*/e2e — run via
          // `pnpm test:e2e`. `*.node.test.ts` belongs to the "node" project.
          exclude: [
            ...configDefaults.exclude,
            "**/e2e/**",
            "**/*.node.test.ts",
          ],
          globals: true,
          testTimeout: 15_000,
          hookTimeout: 30_000,
          setupFiles: ["./src/test/apply-migrations.ts"],
        },
      },
      {
        test: {
          // Plain Node pool for tests that spawn real subprocesses (the
          // Python lane runner) — workerd has no node:child_process.
          name: "node",
          environment: "node",
          globals: true,
          include: ["src/**/*.node.test.ts", "scripts/**/*.node.test.ts"],
        },
      },
    ],
  },
});
