#!/usr/bin/env bash
# Step 13: use the public Cloudflare tunnel addresses (for the demo and real invitation links).
#   1. Start the website helper and two tunnels (three extra Git Bash windows, leave them open):
#        node infra/web-proxy.js
#        cloudflared tunnel --url http://localhost:4566
#        cloudflared tunnel --url http://localhost:8081      (website, through the helper)
#   2. Put the two https://....trycloudflare.com addresses in .env:
#        PUBLIC_API_URL=<first tunnel>
#        PUBLIC_WEB_URL=<second tunnel>
#   3. bash infra/services/13-public-link.sh
# It re-applies only what depends on the address: S3 CORS, the Lambda settings
# (CORS_ORIGINS, FRONTEND_BASE_URL for the email links) and the website config.
# The API itself does not change, so API Gateway is not touched.
# Quick-tunnel addresses change when cloudflared restarts: update .env and run this again.
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
