// Server-side credential scrubbing for captured artifacts. The SDK already
// sanitizes client-side; this is defense-in-depth for anything posted
// directly to the capture protocol (agents, older SDKs, hostile clients).
// Applied to text artifacts (logs, network, debugger payloads, replay HTML)
// at upload time — binary artifacts (video, screenshots) cannot be
// meaningfully scrubbed server-side.

const REDACTED = "[REDACTED]";

// Every pattern uses the same shape: (prefix)(secret)(suffix). The suffix
// group is usually a closing quote/boundary so JSON stays valid.
const PATTERNS: readonly RegExp[] = [
  // JSON header values: "authorization": "..."
  /("(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-auth-token|x-session-token)"\s*:\s*")([^"]*)(")/gi,
  // Bare header/key-value forms: authorization: Bearer x, cookie=...
  /((?:^|[\s{,])(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-auth-token|x-session-token)\s*[:=]\s*"?)([^"&\s,;}]+)("?)/gim,
  // Named secrets in bodies, query strings, and log lines
  /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|pwd|session[_-]?id|session[_-]?token|auth[_-]?token)\s*["']?\s*[:=]\s*"?)([^&\s",;\\}]{4,})("?)/gi,
  // Bearer tokens
  /(Bearer\s+)([A-Za-z0-9\-._~+/]{8,}={0,2})()/g,
  // JWTs
  /()(\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b)()/g,
  // Pile tokens (pil_ capture keys, wgt_/wgs_ widget, capl_ links)
  /()(\b(?:pil|wgt|wgs|capl)_[A-Za-z0-9]{16,}\b)()/g,
  // Common API key shapes (OpenAI, GitHub, Slack)
  /()(\bsk-[A-Za-z0-9]{16,}\b)()/g,
  /()(\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b)()/g,
  /()(\bxox[baprs]-[A-Za-z0-9-]{8,}\b)()/g,
];

export function scrubCaptureText(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(
      pattern,
      (_match, prefix: string, _secret: string, suffix: string) =>
        `${prefix}${REDACTED}${suffix}`
    );
  }
  return out;
}

export const SCRUBBABLE_ATTACHMENT_TYPES = new Set([
  "log",
  "network",
  "debugger_json",
  "replay",
]);

// Lane output additionally carries git remote credentials
// (credentials in the URL userinfo) and secrets whose exact
// values the caller knows (the lane's own session token).
const LANE_PATTERNS: readonly RegExp[] = [/(:\/\/[^:/\s@]+:)([^@\s/]+)(@)/g];

export function scrubLaneText(
  text: string,
  knownSecrets: readonly (string | null | undefined)[] = []
): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of LANE_PATTERNS) {
    out = out.replace(
      pattern,
      (_match, prefix: string, _secret: string, suffix: string) =>
        `${prefix}${REDACTED}${suffix}`
    );
  }
  return scrubCaptureText(out);
}
