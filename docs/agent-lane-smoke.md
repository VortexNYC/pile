# Agent lane smoke — PILE-216

Verbatim output of the smoke commands run in the agent sandbox:

```
$ node --version
v22.23.2

$ pnpm --version
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.15.4.tgz
9.15.4

$ pg_isready -h 127.0.0.1 -p 5432
127.0.0.1:5432 - no response

$ devin --version
devin 3000.11.3 (9c803229faa4)

$ date -u
Tue Sep 29 02:18:36 UTC 2026
```

## Notes

- **Postgres 16 was not already running when the session started.** The
  `16/main` cluster is baked into the image (`pg_lsclusters` shows
  `16 main 5432 down postgres /var/lib/postgresql/16/main`), but nothing
  started it — `pg_isready` returned `no response`. The runner-side start
  step appears to be missing or not firing.
- **Node is v22.23.2, not node24.** The warm image is still shipping the
  node22 toolchain; the node24 bump has not landed in this image.
- pnpm 9.15.4 resolves via Corepack (first invocation downloaded the
  pnpm 9.15.4 tarball from registry.npmjs.org, so Corepack is not
  pre-warmed in the image).
