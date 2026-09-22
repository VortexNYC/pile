-- Enable per-key rate limiting on API keys created before the apiKey
-- plugin's rateLimit was turned on (they were persisted with
-- rate_limit_enabled = 0 and NULL max, which evaluateRateLimit treats as
-- "skip"). New defaults: 600 requests per 60s window per key.
UPDATE apikey
SET rate_limit_enabled = 1,
    rate_limit_max = 600,
    rate_limit_time_window = 60000
WHERE rate_limit_enabled = 0
   OR rate_limit_max IS NULL;
