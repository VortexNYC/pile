export interface AppEnv {
  D1: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  ALLOWED_ORIGINS?: string;
  DEVIN_TOKEN: string;
  GITHUB_WEBHOOK_SECRET?: string;
  WEBHOOK_SECRET?: string;
  DISPATCH_SECRET?: string;
  DEVIN_ORG_ID?: string;
  DEVIN_OUTPOST?: string;
  DAYTONA_LABEL_ID?: string;
}
