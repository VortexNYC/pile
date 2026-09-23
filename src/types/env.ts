import type { Sandbox } from "@cloudflare/sandbox";

export interface AppEnv {
  D1: D1Database;
  ATTACHMENTS_BUCKET?: R2Bucket;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_ADMIN_IDS?: string;
  ALLOWED_ORIGINS?: string;
  DEVIN_TOKEN: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  WEBHOOK_SECRET?: string;
  DISPATCH_SECRET?: string;
  DEVIN_ORG_ID?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_SNAPSHOT?: string;
  DAYTONA_VOLUME_ID?: string;
  DAYTONA_LABEL_ID?: string;
  /** Compute backend for headless CLI providers: "daytona" (default) or "cloudflare". */
  COMPUTE_PROVIDER?: string;
  /** Cloudflare Sandbox binding (Workers Containers) for COMPUTE_PROVIDER=cloudflare. */
  SANDBOX?: DurableObjectNamespace<Sandbox>;
  /** Per-provider sandbox bindings — each backed by its own image. */
  SANDBOX_CURSOR?: DurableObjectNamespace<Sandbox>;
  SANDBOX_DEVIN?: DurableObjectNamespace<Sandbox>;
  SANDBOX_CODEX?: DurableObjectNamespace<Sandbox>;
  OPENAI_API_KEY?: string;
  AGENT_PROVIDER_TOKEN?: string;
  AGENT_PROVIDER_CONFIG?: string;
  /** Encryption key for workspace-scoped agent credentials at rest. Falls back to BETTER_AUTH_SECRET. */
  AGENT_SETTINGS_KEK?: string;
  /** Base64-encoded `~/.codex/auth.json` for the `codex-cli` provider. */
  CODEX_AUTH_JSON_B64?: string;
  /** Codex CLI model override (defaults to `gpt-reserve`). */
  CODEX_CLI_MODEL?: string;
  /** Codex Cloud environment id used by the `codex-cli` provider. */
  CODEX_CLI_ENV_ID?: string;
  /** Base64-encoded `~/.local/share/devin/credentials.toml` for the `devin-cli` provider. */
  DEVIN_CLI_CREDENTIALS_B64?: string;
  /** Devin CLI model override (defaults to `swe-2`). */
  DEVIN_CLI_MODEL?: string;
  /** Cursor API key override for the `cursor-cli` provider (falls back to AGENT_PROVIDER_TOKEN). */
  CURSOR_API_KEY?: string;
  /** Cursor CLI model override (defaults to the CLI's own default). */
  CURSOR_CLI_MODEL?: string;
  FLUE_WORKER?: Fetcher;
  TOKEN_HASH_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_ENCRYPTION_KEY?: string;
  SLACK_REDIRECT_URI?: string;
  // GitLab integration.
  GITLAB_WEBHOOK_SECRET?: string;
  GITLAB_API_URL?: string;
  // Intercom integration.
  INTERCOM_CLIENT_SECRET?: string;
  // Zendesk integration.
  ZENDESK_WEBHOOK_SECRET?: string;
  // Plain integration.
  PLAIN_WEBHOOK_SECRET?: string;
  // Cloudflare Email Service send binding.
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  // Cloudflare Queue for async webhook processing.
  WEBHOOK_QUEUE?: Queue;

  // Additional Worker secrets / bindings referenced by name (e.g. per-channel webhook secrets).
  [key: string]: unknown;
}
