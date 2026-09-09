export interface AppEnv {
  D1: D1Database;
  ATTACHMENTS_BUCKET?: R2Bucket;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  ALLOWED_ORIGINS?: string;
  DEVIN_TOKEN: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  WEBHOOK_SECRET?: string;
  DISPATCH_SECRET?: string;
  DEVIN_ORG_ID?: string;
  DEVIN_OUTPOST?: string;
  DEVIN_OUTPOST_ID?: string;
  DEVIN_OUTPOST_TOKEN?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_SNAPSHOT?: string;
  DAYTONA_VOLUME_ID?: string;
  DAYTONA_LABEL_ID?: string;
  AGENT_PROVIDER_TOKEN?: string;
  AGENT_PROVIDER_CONFIG?: string;
  FLUE_WORKER?: Fetcher;
  TOKEN_HASH_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_ENCRYPTION_KEY?: string;
  SLACK_REDIRECT_URI?: string;
  // Cloudflare Email Service send binding.
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
}
