#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run

if [ "$SETTINGS_ONLY" = 1 ]; then
  step "Code zip"; skip "code unchanged (SETTINGS_ONLY=1)"
else
  step "Code zip"
  node infra/zip-lambda.js
  KEY=lambda/event-manager-$(date +%s).zip
  awsl s3 cp infra/.run/lambda.zip s3://$P-deployments/$KEY >/dev/null
  ok "uploaded to s3://$P-deployments/$KEY"
fi

step "Settings (environment variables) shared by all functions"
TOPIC_ARN=arn:aws:sns:$REGION:$ACCOUNT:$P-domain-events
NOTIFY_URL=$(awsl sqs get-queue-url --queue-name $P-notifications --query QueueUrl --output text)
ORIGINS=$LOCAL_WEB${PUBLIC_WEB:+,$PUBLIC_WEB}
S3_PUBLIC=http://localhost:4566
[ -n "$PUBLIC_API" ] && S3_PUBLIC=$(echo "$PUBLIC_API" | sed -E 's#^(https?://[^/]+).*#\1#')
SENDER_EMAIL=$(envval BREVO_SENDER_EMAIL); SENDER_NAME=$(envval BREVO_SENDER_NAME); TZ_NAME=$(envval DISPLAY_TIME_ZONE)
write_env() {
  cat > infra/.run/env.json <<JSON
{ "Variables": {
  "SERVICE_NAME": "$1",
  "NODE_ENV": "production",
  "LOG_LEVEL": "info",
  "AWS_ENDPOINT_URL": "$LAMBDA_AWS_ENDPOINT",
  "S3_PUBLIC_ENDPOINT": "$S3_PUBLIC",
  "DB_URL_SECRET_NAME": "$P/db-url",
  "JWT_SECRET_NAME": "$P/jwt-secret",
  "TURNSTILE_SECRET_NAME": "$P/turnstile-secret",
  "BREVO_API_KEY_SECRET_NAME": "$P/brevo-api-key",
  "GEOAPIFY_API_KEY_SECRET_NAME": "$P/geoapify-api-key",
  "IMPORTS_BUCKET": "$P-guest-imports",
  "REPORTS_BUCKET": "$P-reports",
  "REQUEST_GUARD_TABLE": "$P-request-guard",
  "DOMAIN_EVENTS_TOPIC_ARN": "$TOPIC_ARN",
  "NOTIFICATIONS_QUEUE_URL": "$NOTIFY_URL",
  "CORS_ORIGINS": "$ORIGINS",
  "FRONTEND_BASE_URL": "$WEB_URL",
  "BREVO_SENDER_EMAIL": "${SENDER_EMAIL}",
  "BREVO_SENDER_NAME": "${SENDER_NAME:-Event Manager}",
  "DISPLAY_TIME_ZONE": "${TZ_NAME:-Africa/Cairo}",
  "DB_POOL_MAX": "2"
} }
JSON
}
ok "secrets by NAME only (em/db-url, em/jwt-secret, ...), buckets, table, topic, queue, CORS $ORIGINS"

step "Functions ($RUNTIME, 512 MB)"
while read -r F HANDLER TIMEOUT; do
  FN=$P-$F-fn
  ROLE_ARN=arn:aws:iam::$ACCOUNT:role/$FN-role
  write_env $FN
  if [ "$SETTINGS_ONLY" = 1 ]; then
    awsl lambda update-function-configuration --function-name $FN --environment file://infra/.run/env.json >/dev/null
    ok "$FN settings updated"
  elif awsl lambda get-function --function-name $FN >/dev/null 2>&1; then
    awsl lambda update-function-code --function-name $FN --s3-bucket $P-deployments --s3-key $KEY >/dev/null
    awsl lambda wait function-updated-v2 --function-name $FN
    awsl lambda update-function-configuration --function-name $FN --role $ROLE_ARN --handler $HANDLER \
      --runtime $RUNTIME --timeout $TIMEOUT --memory-size 512 --environment file://infra/.run/env.json >/dev/null
    awsl lambda wait function-updated-v2 --function-name $FN
    ok "$FN updated"
  else
    awsl lambda create-function --function-name $FN --role $ROLE_ARN --handler $HANDLER \
      --runtime $RUNTIME --timeout $TIMEOUT --memory-size 512 --description "Event Manager" \
      --code S3Bucket=$P-deployments,S3Key=$KEY --environment file://infra/.run/env.json >/dev/null
    awsl lambda wait function-active-v2 --function-name $FN
    ok "$FN created  (handler $HANDLER)"
  fi
done <<'LIST'
auth services/auth/lambdas/api.handler 30
events services/events/lambdas/api.handler 30
rsvp services/rsvp/lambdas/api.handler 30
checkin services/checkin/lambdas/api.handler 30
import services/events/lambdas/importProcessor.handler 120
scheduler services/events/lambdas/scheduler.handler 120
notifier services/events/lambdas/notifier.handler 60
rsvp-consumer services/rsvp/lambdas/consumer.handler 60
report services/checkin/lambdas/reportGenerator.handler 60
LIST

rm -rf infra/.run
echo
echo "Check:  awsl lambda list-functions --query 'Functions[].[FunctionName,State]' --output table"
