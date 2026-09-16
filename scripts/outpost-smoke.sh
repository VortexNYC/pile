#!/usr/bin/env bash
# Smoke test for a Devin outpost worker sandbox provisioned by
# `provisionOutpostWorker` (src/agents/outpost.ts). Run from inside the
# sandbox (e.g. as the first step of a dispatched session) to confirm the
# sandbox was created by the tracker, the worker claimed the session, and the
# toolchain the repo needs is present. Exits non-zero on any failed check.
set -u

fail=0
ok() { printf 'ok    %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}
warn() { printf 'warn  %s\n' "$1"; }

[ -n "${DAYTONA_SANDBOX_ID:-}" ] && ok "daytona sandbox ${DAYTONA_SANDBOX_ID}" || bad "DAYTONA_SANDBOX_ID unset (not a Daytona sandbox)"
[ -n "${OUTPOST_ID:-}" ] && ok "outpost ${OUTPOST_ID}" || bad "OUTPOST_ID unset"
[ -n "${OUTPOST_TOKEN:-}" ] && ok "outpost token present" || bad "OUTPOST_TOKEN unset"
[ -n "${SESSION_ID:-}" ] && ok "pinned session ${SESSION_ID}" || bad "SESSION_ID unset"

if pgrep -f "devin worker start" >/dev/null 2>&1; then
  ok "devin worker process running"
else
  bad "devin worker process not running"
fi

if [ -n "${SESSION_ID:-}" ] && pgrep -f -- "--session=${SESSION_ID}" >/dev/null 2>&1; then
  ok "worker pinned to ${SESSION_ID}"
else
  bad "worker not pinned to SESSION_ID"
fi

if [ -n "${GIT_AUTHOR_NAME:-}" ] && [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then
  ok "git identity ${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>"
else
  warn "GIT_AUTHOR_NAME/EMAIL unset (sandbox created without a git identity)"
fi

if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$node_major" -ge 20 ]; then
    ok "node $(node -v)"
  else
    warn "node $(node -v) is below the repo's >=20.12 engine requirement"
  fi
else
  bad "node not installed"
fi

command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm -v)" || warn "pnpm not installed (repo is pnpm-only)"
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || bad "git not installed"

if [ "$fail" -ne 0 ]; then
  echo "outpost smoke test FAILED"
  exit 1
fi
echo "outpost smoke test passed"
