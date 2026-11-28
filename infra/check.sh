#!/usr/bin/env bash
source "$(dirname "$0")/services/_lib.sh" || exit 1
PASS=0; FAIL=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS $1"; PASS=$((PASS+1)); else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }

echo; echo "S3"
for b in $P-frontend $P-guest-imports $P-reports $P-deployments; do check "bucket $b" "awsl s3api head-bucket --bucket $b"; done
check "em-guest-imports is private" "[ \"\$(awsl s3api get-public-access-block --bucket $P-guest-imports --query 'PublicAccessBlockConfiguration.RestrictPublicBuckets' --output text)\" = True ]"
check "em-guest-imports CORS allows PUT" "awsl s3api get-bucket-cors --bucket $P-guest-imports --query 'CORSRules[0].AllowedMethods' --output text | grep -q PUT"

echo; echo "DynamoDB"
check "table $P-request-guard is ACTIVE" "[ \"\$(awsl dynamodb describe-table --table-name $P-request-guard --query Table.TableStatus --output text)\" = ACTIVE ]"
check "key is pk (String)" "[ \"\$(awsl dynamodb describe-table --table-name $P-request-guard --query 'Table.KeySchema[0].AttributeName' --output text)\" = pk ]"
check "TTL on expires_at" "[ \"\$(awsl dynamodb describe-time-to-live --table-name $P-request-guard --query TimeToLiveDescription.AttributeName --output text)\" = expires_at ]"

echo; echo "SQS"
for Q in $P-rsvp-events $P-checkin-events $P-notifications; do
  URL=$(awsl sqs get-queue-url --queue-name $Q --query QueueUrl --output text 2>/dev/null)
  check "queue $Q" "[ -n \"$URL\" ]"
  check "$Q-dlq" "awsl sqs get-queue-url --queue-name $Q-dlq"
  check "$Q sends failures to its DLQ after 5 tries" "awsl sqs get-queue-attributes --queue-url $URL --attribute-names RedrivePolicy --query Attributes.RedrivePolicy --output text | grep -q '$Q-dlq.*5\\|5.*$Q-dlq'"
done

echo; echo "SNS"
TOPIC=arn:aws:sns:$REGION:$ACCOUNT:$P-domain-events
check "topic $P-domain-events" "awsl sns get-topic-attributes --topic-arn $TOPIC"
check "subscription -> $P-rsvp-events" "awsl sns list-subscriptions-by-topic --topic-arn $TOPIC --query 'Subscriptions[].Endpoint' --output text | grep -q ':$P-rsvp-events'"
check "subscription -> $P-checkin-events" "awsl sns list-subscriptions-by-topic --topic-arn $TOPIC --query 'Subscriptions[].Endpoint' --output text | grep -q ':$P-checkin-events'"
check "$P-checkin-events only gets event.completed (filter)" "for s in \$(awsl sns list-subscriptions-by-topic --topic-arn $TOPIC --query 'Subscriptions[].SubscriptionArn' --output text); do awsl sns get-subscription-attributes --subscription-arn \$s --query Attributes.FilterPolicy --output text; done | grep -q 'event.completed'"

echo; echo "Secrets Manager"
for S in db-url jwt-secret turnstile-secret geoapify-api-key brevo-api-key; do
  check "secret $P/$S" "awsl secretsmanager describe-secret --secret-id $P/$S"
done
check "$P/db-url uses Neon with the em_app user" "awsl secretsmanager get-secret-value --secret-id $P/db-url --query SecretString --output text | grep -q '^postgres.*://em_app:.*neon.tech'"

echo; echo "EventBridge"
check "rule $P-scheduler-every-5-min (rate 5 minutes)" "awsl events describe-rule --name $P-scheduler-every-5-min --query ScheduleExpression --output text | grep -q 'rate(5 minutes)'"
check "rule target is $P-scheduler-fn" "awsl events list-targets-by-rule --rule $P-scheduler-every-5-min --query 'Targets[].Arn' --output text | grep -q $P-scheduler-fn"

echo; echo "IAM + Lambda + CloudWatch"
for f in auth events rsvp checkin import scheduler notifier rsvp-consumer report; do
  check "role $P-$f-fn-role" "awsl iam get-role --role-name $P-$f-fn-role"
  check "function $P-$f-fn is Active" "[ \"\$(awsl lambda get-function --function-name $P-$f-fn --query Configuration.State --output text)\" = Active ]"
  check "log group /aws/lambda/$P-$f-fn" "awsl logs describe-log-groups --log-group-name-prefix /aws/lambda/$P-$f-fn --query 'logGroups[].logGroupName' --output text | grep -q $P-$f-fn"
done
check "alarm em-repeated-failed-logins" "awsl cloudwatch describe-alarms --alarm-names em-repeated-failed-logins --query 'MetricAlarms[0].AlarmName' --output text | grep -q failed-logins"
check "alarm em-repeated-access-denied" "awsl cloudwatch describe-alarms --alarm-names em-repeated-access-denied --query 'MetricAlarms[0].AlarmName' --output text | grep -q access-denied"
check "Lambda gets secrets by NAME only (no value in settings)" "awsl lambda get-function-configuration --function-name $P-events-fn --query Environment.Variables.DB_URL_SECRET_NAME --output text | grep -qx $P/db-url"

echo; echo "Triggers"
for pair in rsvp-events:rsvp-consumer checkin-events:report notifications:notifier; do
  Q=${pair%%:*}; F=${pair##*:}
  check "$P-$Q -> $P-$F-fn" "awsl lambda list-event-source-mappings --function-name $P-$F-fn --query 'EventSourceMappings[].EventSourceArn' --output text | grep -q ':$P-$Q'"
done
check "S3 em-guest-imports/imports/*.csv -> $P-import-fn" "awsl s3api get-bucket-notification-configuration --bucket $P-guest-imports --query 'LambdaFunctionConfigurations[].LambdaFunctionArn' --output text | grep -q $P-import-fn"

echo; echo "API Gateway + website"
API_ID=$(awsl apigateway get-rest-apis --query "items[?name=='$P-api'].id | [0]" --output text 2>/dev/null)
check "REST API $P-api" "[ -n \"$API_ID\" ] && [ \"$API_ID\" != None ]"
check "stage $STAGE" "awsl apigateway get-stage --rest-api-id $API_ID --stage-name $STAGE"
check "18 routes" "[ \$(awsl apigateway get-resources --rest-api-id $API_ID --limit 500 --query 'length(items[?resourceMethods])' --output text) -ge 18 ]"
check "website index.html on S3" "awsl s3api head-object --bucket $P-frontend --key index.html"
check "website config.js points to the API" "awsl s3 cp s3://$P-frontend/shared/config.js - | grep -q restapis/$API_ID"
check "API health answers (Lambda + Neon + secrets)" "curl -s -m 60 $ENDPOINT/restapis/$API_ID/$STAGE/_user_request_/api/health | grep -q '\"status\":\"ok\"'"

echo; echo "$PASS passed, $FAIL failed"
