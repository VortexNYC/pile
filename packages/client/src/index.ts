import type { Client, ClientOptions } from "openapi-fetch";
import createClient from "openapi-fetch";

import type { paths } from "./types.js";

export type { paths };

export type PileClient = Client<paths>;

export function createPileClient(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: ClientOptions["fetch"];
  Request?: ClientOptions["Request"];
}): PileClient {
  return createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/$/u, ""),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    fetch: options.fetch,
    Request: options.Request,
  });
}
