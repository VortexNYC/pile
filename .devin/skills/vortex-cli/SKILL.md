---
name: vortex-cli
description: Use the issuetracker CLI to create and manage issues, support tickets, and workspaces from the command line.
---

# Vortex CLI

## Overview

The `issuetracker` CLI is a generated, OpenAPI-backed command-line client for Vortex. It supports workspace-scoped commands for issues, support tickets, capture, and arbitrary HTTP requests.

## When to use

- You need a quick command-line interface to Vortex.
- You are scripting CI/CD or automation around issues and support tickets.
- You want to manage workspace configuration locally.

## Setup

1. Install the CLI from the `issuetracker-cli` package or run it with `tsx packages/cli/src/index.ts`.
2. Configure an API key: `issuetracker config set --api-key <key>`.
3. Optionally set `ISSUETRACKER_API_KEY` or `ISSUETRACKER_BASE_URL`.

## Common workflows

- List issues: `issuetracker issues list --workspace <org>`
- Create an issue: `issuetracker issues create --workspace <org> --title "..." --team-id <team>`
- List support tickets: `issuetracker support tickets list --workspace <org>`
- Create a support ticket: `issuetracker support tickets create --workspace <org> --customer-id ... --title "..."`
- Make an arbitrary request: `issuetracker request GET /workspaces/<org>/issues`

## Verification

- `issuetracker issues list --workspace <org>` prints a JSON array.
- `issuetracker config set --api-key <key>` writes `~/.issuetracker/config.json`.
