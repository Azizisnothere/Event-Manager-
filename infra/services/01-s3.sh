#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"

step "S3 buckets"
for b in $P-frontend $P-guest-imports $P-reports $P-deployments; do
  if awsl s3api head-bucket --bucket "$b" >/dev/null 2>&1; then skip "bucket $b"
  else awsl s3 mb "s3://$b" >/dev/null; ok "bucket $b created"; fi
done

step "Block public access on the data buckets  [Threat 7]"
for b in $P-guest-imports $P-reports $P-deployments; do
  awsl s3api put-public-access-block --bucket "$b" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  ok "$b: all 4 public-access blocks ON"
done

step "CORS on em-guest-imports"
mkdir -p infra/.run
ORIGINS_JSON="\"$LOCAL_WEB\", \"http://localhost:8080\""
[ -n "$PUBLIC_WEB" ] && ORIGINS_JSON="$ORIGINS_JSON, \"$PUBLIC_WEB\""
cat > infra/.run/cors.json <<JSON
{ "CORSRules": [ { "AllowedOrigins": [ $ORIGINS_JSON ], "AllowedMethods": ["PUT"],
                   "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 600 } ] }
JSON
awsl s3api put-bucket-cors --bucket $P-guest-imports --cors-configuration file://infra/.run/cors.json
rm -rf infra/.run
ok "CORS: PUT only, from $LOCAL_WEB${PUBLIC_WEB:+, $PUBLIC_WEB} and localhost:8080"

echo
echo "Check:  awsl s3 ls"
