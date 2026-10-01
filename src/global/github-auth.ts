import { SignJWT, importPKCS8 } from "jose";
import { z } from "zod";

import type { AppEnv } from "../types/env.js";

const tokenResponseSchema = z.object({
  token: z.string(),
  expires_at: z.string().optional(),
});
const installationSchema = z.object({ id: z.number() });

export const GITHUB_USER_AGENT = "vortex-agent";

async function getAppJwt(env: AppEnv): Promise<string | undefined> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) return undefined;

  let key: CryptoKey;
  try {
    key = await importPKCS8(privateKey, "RS256");
  } catch {
    return undefined;
  }

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setIssuer(appId)
    .setExpirationTime(now + 540)
    .sign(key);

  return jwt;
}

export interface RepoScopedToken {
  token: string;
  /** ISO timestamp GitHub reports for the token's expiry (~1h after mint). */
  expiresAt: string | null;
}

async function createInstallationAccessToken(
  env: AppEnv,
  installationId: string,
  body?: { repositories: string[] }
): Promise<RepoScopedToken | undefined> {
  const jwt = await getAppJwt(env);
  if (!jwt) return undefined;

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GITHUB_USER_AGENT,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );
  if (!response.ok) return undefined;

  const raw: unknown = await response.json();
  const parsed = tokenResponseSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    token: parsed.data.token,
    expiresAt: parsed.data.expires_at ?? null,
  };
}

export async function getInstallationToken(
  env: AppEnv,
  installationId: string
): Promise<string | undefined> {
  return (await createInstallationAccessToken(env, installationId))?.token;
}

async function getInstallationIdForRepo(
  env: AppEnv,
  owner: string,
  name: string
): Promise<string | undefined> {
  const jwt = await getAppJwt(env);
  if (!jwt) return undefined;

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${name}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GITHUB_USER_AGENT,
      },
    }
  );
  if (!response.ok) return undefined;

  const raw: unknown = await response.json();
  const parsed = installationSchema.safeParse(raw);
  return parsed.success ? String(parsed.data.id) : undefined;
}

export async function getInstallationTokenForRepo(
  env: AppEnv,
  owner: string,
  name: string
): Promise<string | undefined> {
  const installationId = await getInstallationIdForRepo(env, owner, name);
  if (!installationId) return undefined;
  return getInstallationToken(env, installationId);
}

/**
 * Installation token restricted to a single repository — what agent lanes
 * get, so a compromised lane can't reach the installation's other repos.
 */
export async function getRepoScopedInstallationToken(
  env: AppEnv,
  owner: string,
  name: string
): Promise<RepoScopedToken | undefined> {
  const installationId = await getInstallationIdForRepo(env, owner, name);
  if (!installationId) return undefined;
  return createInstallationAccessToken(env, installationId, {
    repositories: [name],
  });
}

/**
 * Revoke an installation token before its TTL. Authenticated with the token
 * itself; a 401 means it is already dead, which counts as revoked.
 */
export async function revokeInstallationToken(token: string): Promise<boolean> {
  const response = await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": GITHUB_USER_AGENT,
    },
  });
  return response.status === 204 || response.status === 401;
}
