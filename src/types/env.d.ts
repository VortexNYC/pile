interface D1Migration {
  name: string;
  queries: string[];
}

// Wrangler-generated `Env`/`Cloudflare.Env` extend `__BaseEnv_Env`.
// Adding an index lets runtime env objects (and test `env`) hold extra
// per-channel secret bindings and remain assignable to `AppEnv`/`WorkerEnv`.
interface __BaseEnv_Env {
  [key: string]: unknown;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    ALLOWED_ORIGINS?: string;
    DEVIN_TOKEN: string;
    GITHUB_WEBHOOK_SECRET?: string;
    GITHUB_APP_ID?: string;
    GITHUB_PRIVATE_KEY?: string;
    WEBHOOK_SECRET?: string;
    DISPATCH_SECRET?: string;
    DEVIN_ORG_ID?: string;
    DAYTONA_LABEL_ID?: string;
    TOKEN_HASH_SECRET?: string;
    // Support-channel provider secrets.
    INTERCOM_CLIENT_SECRET?: string;
    ZENDESK_WEBHOOK_SECRET?: string;
    PLAIN_WEBHOOK_SECRET?: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
