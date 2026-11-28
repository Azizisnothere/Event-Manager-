#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../.."
source infra/services/_lib.sh
[ -n "$PUBLIC_WEB" ] && [ -n "$PUBLIC_API" ] || { echo "Set PUBLIC_WEB_URL and PUBLIC_API_URL in .env first (see the top of this file)."; exit 1; }
echo "Website: $PUBLIC_WEB"
echo "API:     $PUBLIC_API"
echo; echo "################ 01-s3 (CORS) ################"
bash infra/services/01-s3.sh
echo; echo "################ 09-lambda (settings only, code unchanged) ################"
SETTINGS_ONLY=1 bash infra/services/09-lambda.sh
echo; echo "################ 12-website (new API address in config.js) ################"
bash infra/services/12-website.sh
echo; echo "Public website: $PUBLIC_WEB/   (invitation emails now link here)"
