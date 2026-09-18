import { VortexError } from "../platform/errors.js";

export const AGENT_SETUP_MODES = ["hosted", "byo"] as const;
export type AgentSetupMode = (typeof AGENT_SETUP_MODES)[number];

export interface CatalogField {
  key: string;
  label: string;
  required: boolean;
  type: "text" | "secret" | "select";
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

export interface CatalogMode {
  id: AgentSetupMode;
  label: string;
  help?: string;
  fields: CatalogField[];
}

export interface CatalogProvider {
  id: string;
  name: string;
  modes: CatalogMode[];
}

const token: CatalogField = {
  key: "token",
  label: "API key",
  required: true,
  type: "secret",
};

const providerOrgId: CatalogField = {
  key: "providerOrgId",
  label: "Provider organization id",
  required: true,
  type: "text",
};

const computeFields: CatalogField[] = [
  {
    key: "computeApiKey",
    label: "Compute API key",
    required: false,
    type: "secret",
    help: "Daytona (or compatible). If set, Pile boots a worker per session.",
  },
  {
    key: "computeApiUrl",
    label: "Compute API URL",
    required: false,
    type: "text",
  },
  {
    key: "computeSnapshot",
    label: "Snapshot",
    required: false,
    type: "text",
  },
  {
    key: "computeVolumeId",
    label: "Volume id",
    required: false,
    type: "text",
  },
];

export const AGENT_PROVIDER_CATALOG: CatalogProvider[] = [
  {
    id: "devin",
    name: "Devin",
    modes: [
      {
        id: "hosted",
        label: "Devin Cloud",
        help: "Sessions run on Devin's infrastructure.",
        fields: [token, providerOrgId],
      },
      {
        id: "byo",
        label: "Your computer or server",
        help: "Devin Outpost. Run workers yourself, or let Pile provision them on Daytona.",
        fields: [
          token,
          providerOrgId,
          {
            key: "outpost",
            label: "Outpost name",
            required: true,
            type: "text",
          },
          {
            key: "outpostId",
            label: "Outpost id",
            required: true,
            type: "text",
          },
          {
            key: "outpostToken",
            label: "Outpost token",
            required: true,
            type: "secret",
          },
          ...computeFields,
        ],
      },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    modes: [
      {
        id: "hosted",
        label: "Cursor Cloud",
        help: "Cursor clones the repo on their infrastructure.",
        fields: [
          token,
          {
            key: "config.repoUrl",
            label: "Default repo URL",
            required: false,
            type: "text",
          },
        ],
      },
      {
        id: "byo",
        label: "Your computer or server",
        help: "Cursor BYOM. A machine or team pool worker you already run. Pile does not boot this VM (ISS-64).",
        fields: [
          token,
          {
            key: "config.env.type",
            label: "Worker kind",
            required: true,
            type: "select",
            options: [
              { value: "machine", label: "This computer (My Machines)" },
              { value: "pool", label: "Team pool" },
            ],
          },
          {
            key: "config.env.name",
            label: "Machine or pool name",
            required: true,
            type: "text",
          },
        ],
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    modes: [
      {
        id: "hosted",
        label: "OpenAI hosted",
        help: "OpenAI runs the Codex harness.",
        fields: [token],
      },
      {
        id: "byo",
        label: "Your computer or server",
        help: "Self-hosted executor. After dispatch, connect your executor to the session remote URL.",
        fields: [token],
      },
    ],
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    modes: [
      {
        id: "byo",
        label: "Your computer or server",
        help: "Pile provisions a Daytona sandbox and runs Codex CLI there.",
        fields: [
          {
            key: "token",
            label: "Codex auth (base64 JSON)",
            required: true,
            type: "secret",
          },
          {
            key: "computeApiKey",
            label: "Daytona API key",
            required: true,
            type: "secret",
          },
          {
            key: "computeApiUrl",
            label: "Daytona API URL",
            required: false,
            type: "text",
          },
          {
            key: "computeSnapshot",
            label: "Snapshot",
            required: false,
            type: "text",
          },
          {
            key: "config.envId",
            label: "Codex environment id",
            required: true,
            type: "text",
          },
        ],
      },
    ],
  },
  {
    id: "devin-cli",
    name: "Devin CLI",
    modes: [
      {
        id: "byo",
        label: "Your computer or server",
        help: "Pile provisions a Daytona sandbox and runs Devin CLI there. Uses your Devin account credentials, not the organization API.",
        fields: [
          {
            key: "token",
            label: "Devin credentials.toml (base64)",
            required: true,
            type: "secret",
          },
          {
            key: "computeApiKey",
            label: "Daytona API key",
            required: true,
            type: "secret",
          },
          {
            key: "computeApiUrl",
            label: "Daytona API URL",
            required: false,
            type: "text",
          },
          {
            key: "computeSnapshot",
            label: "Snapshot",
            required: false,
            type: "text",
          },
          {
            key: "config.model",
            label: "Model",
            required: false,
            type: "text",
          },
        ],
      },
    ],
  },
  {
    id: "cf-agent",
    name: "cf-agent",
    modes: [
      {
        id: "byo",
        label: "Your computer or server",
        help: "Your Agents SDK worker. Pile dispatches to the URL you provide.",
        fields: [
          token,
          {
            key: "config.endpoint",
            label: "Worker URL",
            required: true,
            type: "text",
          },
          {
            key: "config.agent",
            label: "Agent slug",
            required: false,
            type: "text",
          },
        ],
      },
    ],
  },
  {
    id: "flue",
    name: "Flue",
    modes: [
      {
        id: "byo",
        label: "Your computer or server",
        help: "Same contract as cf-agent. Use endpoint `service-binding` to hit this deployment's Flue worker.",
        fields: [
          token,
          {
            key: "config.endpoint",
            label: "Worker URL",
            required: true,
            type: "text",
          },
        ],
      },
    ],
  },
];

export function getCatalogProvider(
  agentId: string
): CatalogProvider | undefined {
  return AGENT_PROVIDER_CATALOG.find((provider) => provider.id === agentId);
}

export function getCatalogMode(
  agentId: string,
  mode: AgentSetupMode
): CatalogMode | undefined {
  return getCatalogProvider(agentId)?.modes.find((item) => item.id === mode);
}

export type ProviderSetupInput = {
  token?: string | null;
  providerOrgId?: string | null;
  outpost?: string | null;
  outpostId?: string | null;
  outpostToken?: string | null;
  computeApiKey?: string | null;
  computeApiUrl?: string | null;
  computeSnapshot?: string | null;
  computeVolumeId?: string | null;
  config?: Record<string, unknown> | null;
};

function readPath(input: ProviderSetupInput, key: string): unknown {
  if (!key.startsWith("config.")) {
    return input[key as keyof ProviderSetupInput];
  }
  let current: unknown = input.config;
  for (const part of key.slice("config.".length).split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function validateProviderSetup(
  agentId: string,
  mode: AgentSetupMode,
  input: ProviderSetupInput
): void {
  const catalogMode = getCatalogMode(agentId, mode);
  if (!catalogMode) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `${agentId} does not support mode ${mode}`,
    });
  }
  const missing = catalogMode.fields
    .filter((field) => field.required && !isFilled(readPath(input, field.key)))
    .map((field) => field.key);
  if (missing.length > 0) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Missing required fields for ${agentId} ${mode}: ${missing.join(", ")}`,
    });
  }
}

export function applyCatalogMode(
  agentId: string,
  mode: AgentSetupMode,
  config: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, mode };
  if (agentId === "codex") {
    const environment =
      typeof next.environment === "object" && next.environment !== null
        ? { ...(next.environment as Record<string, unknown>) }
        : {};
    environment.type = mode === "hosted" ? "openai_hosted" : "self_hosted";
    next.environment = environment;
  }
  return next;
}
