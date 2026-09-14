---
name: pile-cli
description: Use the pile CLI to create and manage issues, support tickets, and workspaces from the command line.
---

# Pile CLI

## Overview

The `pile` CLI is a generated, OpenAPI-backed command-line client for Pile. It supports workspace-scoped commands for issues, support tickets, capture, and arbitrary HTTP requests.

## When to use

- You need a quick command-line interface to Pile.
- You are scripting CI/CD or automation around issues and support tickets.
- You want to manage workspace configuration locally.

## Setup

1. Install the CLI from the `pile-cli` package or run it with `tsx packages/cli/src/index.ts`.
2. Point it at your deployment: `pile config set --base-url https://<your-worker>` (defaults to `http://127.0.0.1:8787` for local `wrangler dev`).
3. Configure an API key: `pile config set --api-key <key>`.
4. Alternatively set `PILE_BASE_URL` / `PILE_API_KEY`; environment variables override the stored config.

## Common workflows

- List issues: `pile issues list --workspace <org>`
- Create an issue: `pile issues create --workspace <org> --title "..." --team-id <team>`
- List support tickets: `pile support tickets list --workspace <org>`
- Create a support ticket: `pile support tickets create --workspace <org> --customer-id ... --title "..."`
- Make an arbitrary request: `pile request GET /workspaces/<org>/issues`

## Verification

- `pile issues list --workspace <org>` prints a JSON array.
- `pile config set --api-key <key>` writes `~/.pile/config.json`.
