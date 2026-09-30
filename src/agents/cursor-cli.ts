import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import {
  SandboxCliAgentProvider,
  type SandboxCliDescriptor,
} from "./sandbox-cli.js";

const descriptor: SandboxCliDescriptor = {
  id: "cursor-cli",
  displayLabel: "Cursor CLI",
  namePrefix: "vortex-cursorcli",
  driver: "cursor",
  defaultModel: "cursor-grok-4.6-medium",
  modelEnv: "CURSOR_CLI_MODEL",
  requireAuth(env) {
    const apiKey = env.CURSOR_API_KEY ?? env.AGENT_PROVIDER_TOKEN;
    if (!apiKey || typeof apiKey !== "string") {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CURSOR_API_KEY is not configured",
      });
    }
    return apiKey;
  },
  credentialEnv: (apiKey) => ({ CURSOR_API_KEY: apiKey }),
};

export class CursorCliAgentProvider extends SandboxCliAgentProvider {
  constructor(env: AppEnv) {
    super(env, descriptor);
  }
}
