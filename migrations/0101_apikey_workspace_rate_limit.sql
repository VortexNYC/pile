-- PILE-259: workspace-scoped API keys (anything minted through the
-- tokens/oauth-clients/clipper/workspace-bootstrap paths, i.e. every key
-- carrying metadata.organizationId) must not ride better-auth's per-key
-- rate limiter — shared machine keys like "agent-dispatch" accumulate
-- request_count and start 429ing mid-session. New keys are created with
-- rateLimitEnabled: false; this repairs the existing rows.
UPDATE `apikey`
SET `rate_limit_enabled` = 0
WHERE `metadata` IS NOT NULL
  AND json_extract(`metadata`, '$.organizationId') IS NOT NULL;
