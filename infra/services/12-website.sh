#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run
B=$P-frontend
API_ID=$(awsl apigateway get-rest-apis --query "items[?name=='$P-api'].id | [0]" --output text)
API_URL=${PUBLIC_API:-$ENDPOINT}/restapis/$API_ID/$STAGE/_user_request_
SITE_KEY=$(envval TURNSTILE_SITE_KEY); SITE_KEY=${SITE_KEY:-1x00000000000000000000AA}

step "Upload frontend/ -> s3://$B"
awsl s3 rm s3://$B --recursive >/dev/null
N=0
while IFS= read -r FILE; do
  KEY=${FILE#frontend/}
  case "$FILE" in
    *.html) TYPE="text/html; charset=utf-8" ;;
    *.js)   TYPE="text/javascript; charset=utf-8" ;;
    *.css)  TYPE="text/css; charset=utf-8" ;;
    *.png)  TYPE=image/png ;;
    *.svg)  TYPE=image/svg+xml ;;
    *.ico)  TYPE=image/x-icon ;;
    *)      TYPE=application/octet-stream ;;
  esac
  SRC=$FILE
  if [ "$KEY" = shared/config.js ]; then
    sed -e "s#API_BASE_URL:[[:space:]]*'[^']*'#API_BASE_URL: '$API_URL'#" \
        -e "s#TURNSTILE_SITE_KEY:[[:space:]]*'[^']*'#TURNSTILE_SITE_KEY: '$SITE_KEY'#" "$FILE" > infra/.run/config.js
    SRC=infra/.run/config.js
  fi
  awsl s3 cp "$SRC" "s3://$B/$KEY" --content-type "$TYPE" --cache-control no-cache >/dev/null
  N=$((N+1))
done < <(find frontend -type f | sort)
ok "$N files uploaded (config.js -> API_BASE_URL $API_URL)"

step "Static website hosting + public read (this bucket only)"
awsl s3 website s3://$B --index-document index.html --error-document index.html
awsl s3api delete-public-access-block --bucket $B 2>/dev/null || true
cat > infra/.run/policy.json <<JSON
{ "Version": "2012-10-17", "Statement": [ { "Sid": "PublicReadWebsite", "Effect": "Allow",
  "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::$B/*" } ] }
JSON
awsl s3api put-bucket-policy --bucket $B --policy file://infra/.run/policy.json
ok "anyone may READ the website files; nobody may write"

rm -rf infra/.run
echo
echo "Website: $WEB_URL/"
