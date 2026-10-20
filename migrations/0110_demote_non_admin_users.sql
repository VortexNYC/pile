-- Users inserted outside Better Auth's own flows (agent/automation users,
-- direct adapter writes) picked up the column default of 'admin', which the
-- better-auth admin plugin reads as global admin. Global admins are an
-- explicit allowlist — Shlomo keeps the role here, and runtime allowlists
-- (BETTER_AUTH_ADMIN_IDS) are unaffected. Idempotent: non-allowlisted rows
-- converge to 'user' on every run and allowlisted admins are untouched.
UPDATE `user`
SET `role` = 'user'
WHERE `email` NOT IN ('shlomo@vortex.nyc', 'shlomo@pile.nyc');
