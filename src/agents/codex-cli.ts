import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import {
  SandboxCliAgentProvider,
  type SandboxCliDescriptor,
} from "./sandbox-cli.js";

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin);
}

function normalizeAuthB64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = atob(value);
    JSON.parse(decoded);
    return value;
  } catch {
    return encodeBase64(value);
  }
}

const descriptor: SandboxCliDescriptor = {
  id: "codex-cli",
  displayLabel: "Codex Cloud",
  namePrefix: "vortex-codex",
  driver: "codex",
  defaultModel: "gpt-reserve",
  modelEnv: "CODEX_CLI_MODEL",
  // Cloud tasks always operate on a repo — no repo-less lanes.
  requiresRepo: true,
  externalExecution: true,
  pushInstruction:
    "Implement the requested change. Verify proportionate to the diff: always run the project's lint/typecheck (for example `pnpm run check`) when the toolchain exists; when you change code, add or extend tests covering the change and run the relevant suites; skip tests entirely when the diff is docs/config-only. Do not burn time on suites that need network egress the sandbox lacks — note the limitation and move on. Make commits with clear messages. Push your changes to the current branch and open a GitHub pull request. Include the full PR URL in your final message.",
  requireAuth(env) {
    const auth = normalizeAuthB64(env.CODEX_AUTH_JSON_B64);
    if (!auth) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CODEX_AUTH_JSON_B64 is not configured",
      });
    }
    return auth;
  },
  requireConfig(env) {
    if (!env.CODEX_CLI_ENV_ID) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CODEX_CLI_ENV_ID is not configured",
      });
    }
  },
  credentialEnv: (auth, env) => ({
    CODEX_AUTH_JSON_B64: auth,
    CODEX_CLI_ENV_ID: env.CODEX_CLI_ENV_ID ?? "",
  }),
};

export class CodexCliAgentProvider extends SandboxCliAgentProvider {
  constructor(env: AppEnv) {
    super(env, descriptor);
  }
}
