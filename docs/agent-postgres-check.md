# Agent Postgres Check

Verification that `pg_ctlcluster` boots PostgreSQL on reused Cloudflare
containers after the `dynamic_shared_memory_type=mmap` fix (VTX-148).

Cluster state (`pg_lsclusters`):

```
Ver Cluster Port Status Owner    Data directory              Log file
16  main    5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log
```

`pg_isready -h 127.0.0.1 -p 5432`:

```
127.0.0.1:5432 - accepting connections
```

`PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -c "select version()"`:

```
                                                                version
---------------------------------------------------------------------------------------------------------------------------------------
 PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg22.04+2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0, 64-bit
(1 row)
```

Result: PASS — PostgreSQL 16 accepts connections on 127.0.0.1:5432.
