-- Post-deploy audit — READ ONLY.
--
-- Lists apikey rows that carry workspace metadata but no server-set
-- `workspace` permission grant (the apikey.permissions column, writable
-- only by server-side createApiKey calls). These keys now resolve as
-- read-only user identities; the owner reviews and revokes them.
--
-- Run per environment, e.g.:
--   wrangler d1 execute <db> --remote --file=scripts/audit-apikeys-without-grant.sql
SELECT
  json_extract(`metadata`, '$.organizationId') AS organizationId,
  `id`,
  `name`,
  `reference_id` AS referenceId,
  json_extract(`metadata`, '$.actorType') AS actorType,
  `permissions`,
  datetime(`created_at` / 1000, 'unixepoch') AS createdAt
FROM `apikey`
WHERE `metadata` IS NOT NULL
  AND json_extract(`metadata`, '$.organizationId') IS NOT NULL
  AND (
    `permissions` IS NULL
    OR json_type(`permissions`, '$.workspace') IS NULL
  )
ORDER BY organizationId, createdAt;
