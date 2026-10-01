import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import {
  SandboxCliAgentProvider,
  type SandboxCliDescriptor,
} from "./sandbox-cli.js";
import { decodeJsonSecret } from "./subscription-pool.js";

function claudeTokenEnv(token: string): Record<string, string> {
  return token.startsWith("sk-ant-api")
    ? { ANTHROPIC_API_KEY: token }
    : { CLAUDE_CODE_OAUTH_TOKEN: token };
}

// Claude Code headless (`claude -p`) in a sandbox. Rides a Claude Pro/Max
// subscription via `claude setup-token` or ~/.claude/.credentials.json, so
// review/triage lanes avoid per-token API billing.
const descriptor: SandboxCliDescriptor = {
  id: "claude-cli",
  displayLabel: "Claude Code",
  namePrefix: "vortex-claude",
  driver: "claude",
  defaultModel: "sonnet",
  modelEnv: "CLAUDE_CLI_MODEL",
  requireAuth(env) {
    const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!token) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message:
          "CLAUDE_CODE_OAUTH_TOKEN is not configured (or add claudeSubscription entries to AGENT_CREDENTIAL_POOL)",
      });
    }
    return token;
  },
  credentialEnv: (token) => claudeTokenEnv(token),
  pool: {
    kinds: ["claudeSubscription", "anthropicApiKey"],
    credentialEnv(entry) {
      const secret = entry.secret.trim();
      if (entry.kind === "anthropicApiKey")
        return { ANTHROPIC_API_KEY: secret };
      const credentials = decodeJsonSecret(secret);
      return credentials
        ? { CLAUDE_CREDENTIALS_JSON_B64: btoa(JSON.stringify(credentials)) }
        : claudeTokenEnv(secret);
    },
  },
};

export class ClaudeCliAgentProvider extends SandboxCliAgentProvider {
  constructor(env: AppEnv) {
    super(env, descriptor);
  }
}
