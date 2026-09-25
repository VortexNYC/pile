#!/usr/bin/env bash
# DR restore drill: rebuild pile-global into a fresh D1 database.
# Usage: ./scripts/dr-restore.sh <new-db-name> [dump-dir]
# Produces: schema + all data rows, verified with per-table counts.
set -euo pipefail

DB="${1:?usage: dr-restore.sh <new-db-name> [dump-dir]}"
DIR="${2:-backups}"
SCHEMA="$DIR/d1-schema.sql"
DATA="$DIR/d1-data.sql"
WRANGLER="$(dirname "$0")/../node_modules/.bin/wrangler"
WORK="$(mktemp -d)"

[[ -f $SCHEMA && -f $DATA ]] || { echo "missing dumps in $DIR — run: wrangler d1 export pile-global --remote --no-data --output $SCHEMA -e production && wrangler d1 export pile-global --remote --no-schema --output $DATA -e production"; exit 1; }

echo "==> creating $DB"
"$WRANGLER" d1 create "$DB" || true

echo "==> applying schema"
"$WRANGLER" d1 execute "$DB" --remote --file "$SCHEMA" -y

# Split data into per-table files; remote import batches statements
# concurrently, so FK-ordered retries converge to a complete restore.
echo "==> splitting data per table"
grep -o 'INSERT INTO "[^"]*"' "$DATA" | sort -u | sed 's/INSERT INTO "//;s/"//' | while read -r t; do
  grep "INSERT INTO \"$t\"" "$DATA" > "$WORK/$t.sql"
done
rm -f "$WORK/sqlite_sequence.sql"   # autoincrement bookkeeping; self-managed, not data
mapfile -t TABLES < <(ls "$WORK" | sed 's/\.sql$//')

remaining=${#TABLES[@]}
for pass in 1 2 3 4 5; do
  [[ $remaining -eq 0 ]] && break
  echo "==> pass $pass: $remaining table(s) pending"
  for t in "${TABLES[@]}"; do
    f="$WORK/$t.sql"
    [[ -f $f ]] || continue
    if "$WRANGLER" d1 execute "$DB" --remote --file "$f" -y >/dev/null 2>&1; then
      rm "$f"; remaining=$((remaining-1))
    else
      echo "    deferred (FK): $t"
    fi
  done
done
[[ $remaining -eq 0 ]] || { echo "FAILED: $remaining tables did not restore"; exit 1; }

echo "==> verifying row counts"
fail=0
for t in "${TABLES[@]}"; do
  want=$(grep -c "INSERT INTO \"$t\"" "$DATA" || true)
  got=$("$WRANGLER" d1 execute "$DB" --remote --command "SELECT count(*) AS c FROM \"$t\"" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['c'])")
  if [[ $want == "$got" ]]; then echo "    ok  $t: $got"; else echo "    MISMATCH $t: want $want got $got"; fail=1; fi
done
rm -rf "$WORK"
[[ $fail -eq 0 ]] && echo "==> restore verified: $DB" || { echo "==> restore INCOMPLETE"; exit 1; }
