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
2. Configure an API key: `pile config set --api-key <key>`.
3. Optionally set `PILE_API_KEY` or `PILE_BASE_URL`.

## Common workflows

- List issues: `pile issues list --workspace <org>`
- Create an issue: `pile issues create --workspace <org> --title "..." --team-id <team>`
- List support tickets: `pile support tickets list --workspace <org>`
- Create a support ticket: `pile support tickets create --workspace <org> --customer-id ... --title "..."`
- Make an arbitrary request: `pile request GET /workspaces/<org>/issues`

## Verification

- `pile issues list --workspace <org>` prints a JSON array.
- `pile config set --api-key <key>` writes `~/.pile/config.json`.
