import type { Client, ClientOptions } from "openapi-fetch";
import createClient from "openapi-fetch";

import type { paths } from "./types.js";

export type { paths };

export type IssueTrackerClient = Client<paths>;

export function createIssueTrackerClient(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: ClientOptions["fetch"];
  Request?: ClientOptions["Request"];
}): IssueTrackerClient {
  return createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/$/u, ""),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    fetch: options.fetch,
    Request: options.Request,
  });
}
