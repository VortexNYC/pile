#!/usr/bin/env bash
# Production backup: D1 schema+data dumps, per-workspace export, R2 manifest.
# Usage: ./scripts/backup.sh [out-dir]   (default backups/<date>)
# Requires: wrangler authed, ~/.pile/config.json apiKey, CF_API_TOKEN optional
# (falls back to the wrangler OAuth token for the R2 manifest).
set -euo pipefail

DIR="${1:-backups/$(date +%Y%m%d-%H%M%S)}"
WRANGLER="$(dirname "$0")/../node_modules/.bin/wrangler"
ACCOUNT_ID="31bfc2c14a28e0a39e8b9e3c556a18be"
API="https://pile.nyc"
mkdir -p "$DIR"

echo "==> D1 schema dump"
"$WRANGLER" d1 export pile-global --remote --no-data --output "$DIR/d1-schema.sql" -e production
echo "==> D1 data dump"
"$WRANGLER" d1 export pile-global --remote --no-schema --output "$DIR/d1-data.sql" -e production

KEY=$(python3 -c "import json;print(json.load(open('$HOME/.pile/config.json'))['apiKey'])")
for org in org_vortex_main; do
  echo "==> workspace export: $org"
  curl -sf "$API/workspaces/$org/export" -H "Authorization: Bearer $KEY" -o "$DIR/workspace-$org.json"
done

echo "==> R2 manifest (pile-attachments)"
TOKEN="${CF_API_TOKEN:-$(grep oauth_token ~/.wrangler/config/default.toml | cut -d'"' -f2)}"
python3 - "$TOKEN" "$ACCOUNT_ID" "$DIR/r2-manifest.json" <<'PY'
import json,sys,urllib.request
tok,acc,out=sys.argv[1:4]
keys=[];cursor=None
while True:
    url=f"https://api.cloudflare.com/client/v4/accounts/{acc}/r2/buckets/pile-attachments/objects?per_page=1000"
    if cursor:url+=f"&cursor={cursor}"
    d=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={"Authorization":f"Bearer {tok}"})))
    r=d.get("result") or []
    keys+=[o["key"] for o in r]
    i=d.get("result_info") or {}
    cursor=i.get("cursor") if i.get("is_truncated") else None
    if not cursor:break
json.dump(keys,open(out,"w"))
print(f"    {len(keys)} objects")
PY

echo "==> done: $DIR"
ls -la "$DIR"
