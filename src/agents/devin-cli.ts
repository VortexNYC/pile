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

function normalizeCredentialsB64(
  value: string | undefined
): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = atob(value);
    if (decoded.includes("=")) return value;
  } catch {
    // not valid base64 — encode raw TOML below
  }
  return encodeBase64(value);
}

const descriptor: SandboxCliDescriptor = {
  id: "devin-cli",
  displayLabel: "Devin",
  namePrefix: "vortex-devin",
  driver: "devin",
  defaultModel: "swe-2",
  modelEnv: "DEVIN_CLI_MODEL",
  // Kept-sandbox follow-up channel: sendPrompt injects into the running
  // process's stdin via /tmp/followups, or resumes a FOLLOWUP=1 run.
  followup: true,
  requireAuth(env) {
    const creds = normalizeCredentialsB64(env.DEVIN_CLI_CREDENTIALS_B64);
    if (!creds) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DEVIN_CLI_CREDENTIALS_B64 is not configured",
      });
    }
    return creds;
  },
  credentialEnv: (creds) => ({ DEVIN_CREDENTIALS_B64: creds }),
};

export class DevinCliAgentProvider extends SandboxCliAgentProvider {
  constructor(env: AppEnv) {
    super(env, descriptor);
  }
}
