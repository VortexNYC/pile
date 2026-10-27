// Shared OpenAPI document metadata — consumed by both the live /openapi.json
// route (api/index.ts `app.doc`) and the committed spec artifact
// (scripts/generate-openapi.ts `getOpenAPIDocument`). The two paths take
// separate config objects, so the security model and servers live here once.
//
// Every operation defaults to the workspace bearer key; genuinely public
// routes (webhooks, health, docs, token-shared links) opt out with
// `security: []` on their route definition.
export const openapiDocumentConfig = {
  servers: [
    {
      url: "https://pile.nyc",
      description:
        "Production. Self-hosted deployments serve the same API from the deployed worker's host.",
    },
  ],
  security: [{ bearerAuth: [] }],
};

/** The workspace API-key scheme every operation defaults to. Registered on
 *  `app.openAPIRegistry` — passing `components` through the doc config is
 *  silently dropped by the generator. */
export const bearerAuthScheme = {
  type: "http",
  scheme: "bearer",
  description:
    "Workspace API key (`Authorization: Bearer <key>`). Issue keys under Settings → Developer or POST /workspaces/{organizationId}/tokens.",
} as const;
