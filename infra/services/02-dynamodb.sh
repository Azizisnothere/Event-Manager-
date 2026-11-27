#!/usr/bin/env bash
# Service 2: Amazon DynamoDB - table em-request-guard  (Abdelaziz)
#   Stores rate-limit counters (too many logins / RSVPs from one person) and
#   idempotency keys (the same RSVP sent twice is counted once).
#   Every item has an expires_at time; TTL deletes old items automatically.
# Run: bash infra/services/02-dynamodb.sh      (safe to run again)
set -e
source "$(dirname "$0")/_lib.sh"
TABLE=$P-request-guard

step "DynamoDB table $TABLE"
if awsl dynamodb describe-table --table-name $TABLE >/dev/null 2>&1; then skip "table $TABLE"
else
  awsl dynamodb create-table --table-name $TABLE \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  awsl dynamodb wait table-exists --table-name $TABLE
  ok "table $TABLE created (key pk, String, on-demand)"
fi

step "Time to live (TTL) on expires_at"
if [ "$(awsl dynamodb describe-time-to-live --table-name $TABLE --query TimeToLiveDescription.TimeToLiveStatus --output text)" = ENABLED ]; then
  skip "TTL"
else
  awsl dynamodb update-time-to-live --table-name $TABLE \
    --time-to-live-specification Enabled=true,AttributeName=expires_at >/dev/null
  ok "TTL ON: items are deleted after their expires_at time"
fi

echo
echo "Check:  awsl dynamodb describe-table --table-name $TABLE --query 'Table.[TableName,TableStatus,KeySchema[0].AttributeName]'"
