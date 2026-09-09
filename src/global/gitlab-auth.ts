import type { AppEnv } from "../types/env.js";

export function getGitlabApiBase(env: AppEnv): string {
  return env.GITLAB_API_URL?.replace(/\/$/, "") ?? "https://gitlab.com/api/v4";
}

export async function gitlabFetch(
  env: AppEnv,
  token: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const base = getGitlabApiBase(env);
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}
