import {
  bindings,
  defineConfig,
  defineContainer,
  exports,
  triggers,
} from "cf/config";
import type { CloudflareConfig } from "cf/config";

/**
 * cf-native project configuration, migrated from wrangler.toml (PILE-243).
 *
 * `wrangler.toml` remains the canonical deploy config during the transition:
 * plain `wrangler deploy` keeps reading it, while `cf` reads this file (as
 * does `wrangler --experimental-new-config`, which maps `--env`/`CLOUDFLARE_ENV`
 * onto `ctx.mode`).
 *
 * Migration notes (see docs/cf-migration-report.md):
 *
 * - The wrangler `[[migrations]]` `new_sqlite_classes` chain (v1–v3) is
 *   replaced by the declarative `worker.exports` map in each mode branch.
 *   Every Durable Object class must be declared with `storage: "sqlite"` —
 *   omitting a live class or using `"legacy-kv"` risks detaching or
 *   reprovisioning the namespace with the wrong storage engine.
 * - Container apps are declared with `defineContainer` and linked to their
 *   Durable Object class through `exports.<class>.container`. Their `name`s
 *   must match wrangler's derivation (`<worker>-<class>[-<env>]`,
 *   lowercased): a different name makes `cf deploy` provision *new*
 *   container applications and orphan the existing instances.
 * - D1 `migrations_dir` has no config equivalent under cf — migrations are a
 *   CLI concern: `cf d1 migrations apply <database> --dir ./migrations`
 *   (the `--dir`/`--pattern`/`--table` defaults already match this repo's
 *   layout and bookkeeping table).
 * - Secrets stay CLI-managed (`cf workers secrets update` /
 *   `cf deploy --secrets-file`); `.dev.vars` handling under `cf dev` is
 *   unverified — keep `wrangler dev` for local development until checked.
 */

// Builds a self-referencing `bindings.durableObject` whose `exportName` is
// keyed on the worker's `exports` map, so a mistyped class name fails to
// compile instead of failing at deploy time.
const selfDurableObjectBinding =
  <T extends Record<string, unknown>>(worker: string) =>
  (exportName: Extract<keyof T, string>) =>
    bindings.durableObject({ worker, exportName });

export default defineConfig((ctx): CloudflareConfig => {
  // Wrangler evaluates the top-level (self-host/dev) config when no `--env`
  // is given, which surfaces here as `mode === undefined`; `cf` only sets
  // mode via `--mode`. Unknown modes must not fall through to the dev
  // branch — under wrangler a typo'd `-e` is an error, not a silent
  // environment change.
  const mode = ctx.mode ?? "development";
  switch (mode) {
    case "production": {
      const sandbox = defineContainer({
        name: "pile-sandbox-production",
        // Pinned registry digest — `cf deploy`/`wrangler deploy` must
        // not require a Docker daemon (cloudflare-ci's sandbox has
        // none). The Dockerfiles remain the source of truth for image
        // contents; releasing a new image is a docker-host step:
        //   wrangler containers build -p -t <name>:<tag> -f Dockerfile.sandbox-* .
        // then update the digest here. `wrangler containers info
        // <app-id>` shows the digest a pushed tag landed on.
        image: {
          reference:
            "registry.cloudflare.com/31bfc2c14a28e0a39e8b9e3c556a18be/pile-sandbox-production@sha256:177e408e62062b025a6e9a75a659eb88bd271a4dcd0e4a8e8d40bdaaa5fae5b4",
        },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const cursorSandbox = defineContainer({
        name: "pile-cursorsandbox-production",
        image: {
          reference:
            "registry.cloudflare.com/31bfc2c14a28e0a39e8b9e3c556a18be/pile-cursorsandbox-production@sha256:28a55370d583c03721d6dc9b52e7b908c27e148cf860ca5ba63000e99cc4a87c",
        },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const devinSandbox = defineContainer({
        name: "pile-devinsandbox-production",
        image: {
          reference:
            "registry.cloudflare.com/31bfc2c14a28e0a39e8b9e3c556a18be/pile-devinsandbox-production@sha256:c9b3773bf482587377c71c8c84511aa7530de19745b7c7ca0ab83ff3a0e4cf73",
        },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const codexSandbox = defineContainer({
        name: "pile-codexsandbox-production",
        image: {
          reference:
            "registry.cloudflare.com/31bfc2c14a28e0a39e8b9e3c556a18be/pile-codexsandbox-production@sha256:a88dcb498f92a2cdb53b7f9480a83cbd4be92966a05c0fb133bc63204596e4c6",
        },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const workerExports = {
        WorkspaceDO: exports.durableObject({ storage: "sqlite" }),
        Sandbox: exports.durableObject({
          storage: "sqlite",
          container: sandbox,
        }),
        CursorSandbox: exports.durableObject({
          storage: "sqlite",
          container: cursorSandbox,
        }),
        DevinSandbox: exports.durableObject({
          storage: "sqlite",
          container: devinSandbox,
        }),
        CodexSandbox: exports.durableObject({
          storage: "sqlite",
          container: codexSandbox,
        }),
      };
      const doBinding = selfDurableObjectBinding<typeof workerExports>("pile");
      return {
        worker: {
          name: "pile",
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          entrypoint: "src/index.ts",
          domains: ["pile.nyc"],
          // wrangler defaults `workers_dev` to false when routes are
          // configured; keep that here so the workers.dev subdomain
          // stays off.
          workersDev: false,
          triggers: [
            triggers.scheduled({
              schedule: "*/5 * * * *",
            }),
            triggers.queue({
              maxBatchSize: 10,
              maxBatchTimeout: 5,
              maxRetries: 3,
              name: "webhook-queue",
            }),
          ],
          env: {
            BETTER_AUTH_URL: bindings.text("https://pile.nyc"),
            ALLOWED_ORIGINS: bindings.text("https://pile.nyc"),
            SLACK_REDIRECT_URI: bindings.text("https://pile.nyc/slack/oauth"),
            DAYTONA_SNAPSHOT: bindings.text("vortex-cli-runner-v2"),
            DAYTONA_VOLUME_ID: bindings.text(
              "0f79e741-e373-496b-a83f-7252cd5b9f12"
            ),
            DEVIN_MODEL: bindings.text("swe-2"),
            EMAIL_FROM: bindings.text("notifications@pile.nyc"),
            COMPUTE_PROVIDER: bindings.text("cloudflare"),
            PUBLIC_API_URL: bindings.text("https://pile.nyc"),
            FEEDBACK_CHANNEL_ID: bindings.text(
              "cc2f808d-007e-48a1-870f-bd4c68ae0cd6"
            ),
            D1: bindings.d1({
              name: "pile-global",
              id: "c4f71628-3f93-4be1-ac11-48b5611f5934",
            }),
            ATTACHMENTS_BUCKET: bindings.r2({
              name: "pile-attachments",
            }),
            EMAIL: bindings.sendEmail({}),
            WEBHOOK_QUEUE: bindings.queue({
              name: "webhook-queue",
            }),
            WORKSPACE_DURABLE_OBJECT: doBinding("WorkspaceDO"),
            SANDBOX: doBinding("Sandbox"),
            SANDBOX_CURSOR: doBinding("CursorSandbox"),
            SANDBOX_DEVIN: doBinding("DevinSandbox"),
            SANDBOX_CODEX: doBinding("CodexSandbox"),
          },
          exports: workerExports,
        },
        containers: [sandbox, cursorSandbox, devinSandbox, codexSandbox],
      };
    }
    case "development": {
      const sandbox = defineContainer({
        name: "pile-dev-sandbox",
        image: { dockerfile: "./Dockerfile.sandbox" },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const cursorSandbox = defineContainer({
        name: "pile-dev-cursorsandbox",
        image: { dockerfile: "./Dockerfile.sandbox-cursor" },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const devinSandbox = defineContainer({
        name: "pile-dev-devinsandbox",
        image: { dockerfile: "./Dockerfile.sandbox-devin" },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const codexSandbox = defineContainer({
        name: "pile-dev-codexsandbox",
        image: { dockerfile: "./Dockerfile.sandbox-codex" },
        maxInstances: 20,
        instanceType: "standard-1",
      });
      const workerExports = {
        WorkspaceDO: exports.durableObject({ storage: "sqlite" }),
        Sandbox: exports.durableObject({
          storage: "sqlite",
          container: sandbox,
        }),
        CursorSandbox: exports.durableObject({
          storage: "sqlite",
          container: cursorSandbox,
        }),
        DevinSandbox: exports.durableObject({
          storage: "sqlite",
          container: devinSandbox,
        }),
        CodexSandbox: exports.durableObject({
          storage: "sqlite",
          container: codexSandbox,
        }),
      };
      const doBinding =
        selfDurableObjectBinding<typeof workerExports>("pile-dev");
      return {
        worker: {
          name: "pile-dev",
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          entrypoint: "src/index.ts",
          triggers: [
            triggers.scheduled({
              schedule: "*/5 * * * *",
            }),
            triggers.queue({
              maxBatchSize: 10,
              maxBatchTimeout: 5,
              maxRetries: 3,
              name: "webhook-queue",
            }),
          ],
          env: {
            BETTER_AUTH_URL: bindings.text("https://pile.example.workers.dev"),
            ALLOWED_ORIGINS: bindings.text("https://pile.example.workers.dev"),
            SLACK_REDIRECT_URI: bindings.text(
              "https://pile.example.workers.dev/slack/oauth"
            ),
            COMPUTE_PROVIDER: bindings.text("cloudflare"),
            EMAIL_FROM: bindings.text("notifications@example.com"),
            D1: bindings.d1({
              name: "pile-global",
            }),
            ATTACHMENTS_BUCKET: bindings.r2({
              name: "pile-attachments",
            }),
            EMAIL: bindings.sendEmail({}),
            WEBHOOK_QUEUE: bindings.queue({
              name: "webhook-queue",
            }),
            WORKSPACE_DURABLE_OBJECT: doBinding("WorkspaceDO"),
            SANDBOX: doBinding("Sandbox"),
            SANDBOX_CURSOR: doBinding("CursorSandbox"),
            SANDBOX_DEVIN: doBinding("DevinSandbox"),
            SANDBOX_CODEX: doBinding("CodexSandbox"),
          },
          exports: workerExports,
        },
        containers: [sandbox, cursorSandbox, devinSandbox, codexSandbox],
      };
    }
    default: {
      throw new Error(
        `Unknown cf mode ${JSON.stringify(ctx.mode)} — expected "production" or "development" (unset maps to development).`
      );
    }
  }
});
