---
name: pile-agent
description: Dispatch and track other coding agents from a Pile workspace.
---

# Pile agent dispatch

## Overview

Pile can start, poll, and stop other agents on your behalf. Use this when you need to hand an issue off to a Devin, Cursor, or Flue agent and then track the result.

## When to use

- An issue should be worked on by another agent.
- You want to delegate without leaving Pile.
- You want to poll a running or completed agent session.

## Prerequisites

- A Pile API token with `agent:write` permission.
- The issue you want to dispatch already exists.

## Dispatch an agent for an issue

### CLI

```bash
pile issues dispatch --workspace <org> --id <issue-id> --agent-id devin
```

Or with a specific model:

```bash
pile issues dispatch --workspace <org> --id <issue-id> --agent-id devin --model "claude-sonnet-4"
```

### API

```bash
curl -X POST "https://<worker>/workspaces/<org>/issues/<issue-id>/dispatch" \
  -H "Authorization: Bearer $PILE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "devin"}'
```

The response contains the `id` of the agent session and a `url` you can open.

## List agent sessions

### CLI

```bash
pile agent sessions list --workspace <org>
pile agent sessions list --workspace <org> --issue <issue-id>
```

### API

```bash
GET /workspaces/<org>/agent/sessions?issueId=<issue-id>
```

## Poll a session for the latest status

### CLI

```bash
pile agent sessions poll create --workspace <org> --session <session-id>
```

### API

```bash
POST /workspaces/<org>/agent/sessions/<session-id>/poll
```

## Inspect a session

```bash
pile agent sessions get --workspace <org> --session <session-id>
```

## Cancel a session

```bash
pile agent sessions cancel create --workspace <org> --session <session-id>
```

## Verification

- `pile agent sessions list --workspace <org>` returns sessions with `status` and `url`.
- `pile issues dispatch ...` returns `201` with a `url` and `id`.
- `pile agent sessions poll create ...` updates `status` and `result`.

## Notes

- If you do not set `--agent-id`, the default is `devin`.
- Sessions move from `created` to `running` to `completed` or `failed`.
- The `result` field may contain a summary from the provider.
