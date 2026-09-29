# Agent token refresh — environment check

The runner calls the lane GitHub-token refresh endpoint before cloning. This
document records the toolchain versions observed in the agent sandbox at the
time of the check.

## `node --version`

```
v24.21.0
```

## `pnpm --version`

```
9.15.4
```

## `pg_isready -h 127.0.0.1 -p 5432`

```
127.0.0.1:5432 - no response
```

Exit code: 2 (no PostgreSQL listening on localhost in the sandbox).
