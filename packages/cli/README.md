# @vortex-api/pile

Pile — the agent-native issue tracker and support desk. The support ticket and
the engineering issue are the same object; coding agents are first-class users
that record bugs, read capture artifacts, and open fix PRs.

One package ships the whole surface:

| Import / command                   | What                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `@vortex-api/pile`                 | TypeScript SDK (`createPileClient`, typed OpenAPI client)                    |
| `@vortex-api/pile/capture`         | Browser capture SDK — console, network, errors, rrweb replay, debugger state |
| `@vortex-api/pile/chat.js`         | Embeddable support widget (IIFE)                                             |
| `@vortex-api/pile/capture.iife.js` | One-tag capture script                                                       |
| `pile`                             | CLI — issues, tickets, agent sessions, capture                               |

## Quickstart

```bash
npm i @vortex-api/pile
pile init        # sign up → workspace → API key, one command
```

Or drive the API directly:

```bash
curl -X POST https://pile.nyc/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@co.com","password":"…","name":"You"}'

curl -X POST https://pile.nyc/workspaces/onboard \
  -H 'Cookie: <session>' -H 'Content-Type: application/json' \
  -d '{"name":"Acme","slug":"acme","key":"ACM"}'
# → { workspace, team, token }
```

## Embed capture

```html
<script
  src="https://pile.nyc/capture.js"
  data-pile-key="pil_…"
  data-pile-replay="true"
></script>
```

or programmatically:

```ts
import { initCapture } from "@vortex-api/pile/capture";
const capture = initCapture({ publicKey: "pil_…" });
```

## Support widget

```html
<script src="https://pile.nyc/chat.js" data-pile-widget="wgt_…"></script>
```

## For agents

- `GET /llms.txt` — machine-readable index of surfaces and docs
- `GET /llms-full.txt` — the full docs corpus
- `POST /mcp` — MCP server exposing issue/ticket/workspace tools
- `GET /openapi.json` — the full API contract

Apache-2.0 · https://pile.nyc
