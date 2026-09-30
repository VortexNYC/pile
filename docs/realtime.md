# Realtime Events

`GET /workspaces/{org}/realtime` is a WebSocket endpoint that streams
`RealtimeEvent` frames for the workspace: `issue.created`,
`issue.updated`, `issue.deleted`, `comment.*`, `document.*`,
`pr.updated`, and so on. The connection lands on the workspace's Durable
Object, so every client sees the same event stream plus outbound webhook
deliveries.

```bash
# Non-browser clients: normal Bearer auth on the upgrade request.
curl -si -N \
  -H "Authorization: Bearer $KEY" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $KEY16" \
  "$BASE/workspaces/$ORG/realtime"
```

A successful upgrade returns `101 Switching Protocols` and the first frame
is `{"type":"connected","organizationId":"..."}`. Non-upgrade requests get
`426 UPGRADE_REQUIRED`.

## Browser clients (`?token=`)

`window.WebSocket` cannot set request headers, so the realtime endpoints
(`/realtime` and the legacy `/ws` alias) also accept the workspace API key
as a query parameter:

```js
const ws = new WebSocket(
  `wss://pile.example.com/workspaces/${org}/realtime?token=${key}`
);
```

`?token=` is scoped to those paths only — it is not a general auth
mechanism, since URLs end up in logs and browser history. Prefer a
short-lived or least-privilege key, and do not embed it in anything
linkable. `Authorization: Bearer` still works and takes precedence when
both are present.

## Ping / pong

Send `{"type":"ping"}`; the DO replies `{"type":"pong"}`. Use it to keep the
connection alive or detect a dead peer — hibernating Durable Objects do not
emit WebSocket protocol pings on their own.
