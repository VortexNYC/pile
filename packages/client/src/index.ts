import createClient from "openapi-fetch";
import type { Client } from "openapi-fetch";
import type { paths } from "./types.js";

export type { paths };

export type IssueTrackerClient = Client<paths>;

export function createIssueTrackerClient(options: {
  baseUrl: string;
  apiKey: string;
}): IssueTrackerClient {
  return createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/$/u, ""),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
  });
}
