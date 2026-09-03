interface D1Migration {
  name: string;
  queries: string[];
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
    TEST_MIGRATIONS: D1Migration[];
  }
}
