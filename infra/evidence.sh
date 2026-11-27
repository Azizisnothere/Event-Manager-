#!/usr/bin/env bash
# Collects the cloud evidence for the report: every command and its real output
# (like the labs: "copy the command and its output"), one file per service,
# then zips it as docs/evidence/cloud-evidence.zip.
# Secret VALUES are never printed (only their names). .env is never included.
# Run from the project folder in Git Bash:   bash infra/evidence.sh
cd "$(dirname "$0")/.."
source infra/services/_lib.sh || exit 1
OUT=docs/evidence/cloud
rm -rf "$OUT"; mkdir -p "$OUT"
API_ID=$(awsl apigateway get-rest-apis --query "items[?name=='$P-api'].id | [0]" --output text)
API_LOCAL=$ENDPOINT/restapis/$API_ID/$STAGE/_user_request_
TOPIC=arn:aws:sns:$REGION:$ACCOUNT:$P-domain-events

FILE=""
section() { FILE="$OUT/$1.txt"; { echo "# $2"; echo "# Event Manager on Floci (account $ACCOUNT, region $REGION), collected $(date -u +%FT%TZ)"; echo; } > "$FILE"; echo "  writing $FILE"; }
run() { { echo "\$ $*"; eval "$@" 2>&1; echo; } >> "$FILE"; }     # command + its output
note() { echo "$*" >> "$FILE"; echo >> "$FILE"; }

section 00-check "Automated check of every service (bash infra/check.sh)"
run bash infra/check.sh

section 01-s3 "S3: 4 buckets; data buckets private; CORS PUT-only; website public read-only; CSV upload trigger"
run awsl s3 ls
for b in $P-guest-imports $P-reports $P-deployments; do run awsl s3api get-public-access-block --bucket $b; done
run awsl s3api get-bucket-cors --bucket $P-guest-imports
run awsl s3api get-bucket-notification-configuration --bucket $P-guest-imports
run awsl s3api get-bucket-website --bucket $P-frontend
run awsl s3api get-bucket-policy --bucket $P-frontend --query Policy --output text
run "awsl s3 ls s3://$P-frontend --recursive | head -40"

section 02-dynamodb "DynamoDB: em-request-guard (rate limits + idempotency), on-demand, TTL on expires_at"
run awsl dynamodb describe-table --table-name $P-request-guard --query "'Table.{Name:TableName,Status:TableStatus,Key:KeySchema,Billing:BillingModeSummary.BillingMode}'"
run awsl dynamodb describe-time-to-live --table-name $P-request-guard
run awsl dynamodb scan --table-name $P-request-guard --select COUNT

section 03-sqs "SQS: 3 work queues, each with a dead-letter queue (5 tries, 14 days), queue policy = only our SNS topic"
run awsl sqs list-queues
for q in $P-rsvp-events $P-checkin-events $P-notifications; do
  U=$(awsl sqs get-queue-url --queue-name $q --query QueueUrl --output text)
  run awsl sqs get-queue-attributes --queue-url $U --attribute-names VisibilityTimeout RedrivePolicy Policy ApproximateNumberOfMessages
done
U=$(awsl sqs get-queue-url --queue-name $P-rsvp-events-dlq --query QueueUrl --output text)
run awsl sqs get-queue-attributes --queue-url $U --attribute-names MessageRetentionPeriod ApproximateNumberOfMessages

section 04-sns "SNS: em-domain-events fan-out with filter policies; em-security-alerts for alarms"
run awsl sns list-topics
run awsl sns list-subscriptions-by-topic --topic-arn $TOPIC
for s in $(awsl sns list-subscriptions-by-topic --topic-arn $TOPIC --query 'Subscriptions[].SubscriptionArn' --output text); do
  run awsl sns get-subscription-attributes --subscription-arn $s --query "'Attributes.{Endpoint:Endpoint,FilterPolicy:FilterPolicy,RawMessageDelivery:RawMessageDelivery}'"
done

section 05-secrets "Secrets Manager: 5 secrets (names only, values are never shown); Lambdas get only the NAMES"
run awsl secretsmanager list-secrets --query "'SecretList[].{Name:Name,Created:CreatedDate}'" --output table
run awsl lambda get-function-configuration --function-name $P-events-fn --query "'Environment.Variables.{DB:DB_URL_SECRET_NAME,JWT:JWT_SECRET_NAME,GEOAPIFY:GEOAPIFY_API_KEY_SECRET_NAME,BREVO:BREVO_API_KEY_SECRET_NAME}'"

section 06-eventbridge "EventBridge: rule every 5 minutes -> em-scheduler-fn"
run awsl events describe-rule --name $P-scheduler-every-5-min
run awsl events list-targets-by-rule --rule $P-scheduler-every-5-min

section 07-iam "IAM: one role per Lambda; trust policy = only lambda.amazonaws.com; permission policies written by each owner"
run awsl iam list-roles --query "'Roles[?starts_with(RoleName, \`$P-\`)].RoleName'"
run awsl iam get-role --role-name $P-events-fn-role --query "'Role.AssumeRolePolicyDocument'"
for f in auth events rsvp checkin import scheduler notifier rsvp-consumer report; do
  run awsl iam list-role-policies --role-name $P-$f-fn-role
done
note "Policy files in the repo: $(ls infra/iam/policies/ 2>/dev/null | tr '\n' ' ')"

section 08-cloudwatch "CloudWatch: log groups (14 days), security metric filters, alarms -> em-security-alerts"
run awsl logs describe-log-groups --log-group-name-prefix /aws/lambda/$P- --query "'logGroups[].{Group:logGroupName,RetentionDays:retentionInDays}'" --output table
run awsl logs describe-metric-filters --log-group-name /aws/lambda/$P-auth-fn --query "'metricFilters[].{Filter:filterName,Pattern:filterPattern,Metric:metricTransformations[0].metricName}'" --output table
run awsl cloudwatch describe-alarms --query "'MetricAlarms[].{Alarm:AlarmName,Metric:MetricName,Threshold:Threshold,PeriodSec:Period,State:StateValue,Action:AlarmActions[0]}'" --output table
run "awsl logs tail /aws/lambda/$P-auth-fn --since 24h --format short | tail -15"
run "awsl logs tail /aws/lambda/$P-events-fn --since 24h --format short | tail -15"

section 09-lambda "Lambda: 9 functions (runtime, handler, role, timeout, state)"
run awsl lambda list-functions --query "'Functions[?starts_with(FunctionName, \`$P-\`)].{Name:FunctionName,Runtime:Runtime,Handler:Handler,Timeout:Timeout,MemoryMB:MemorySize}'" --output table
for f in auth events rsvp checkin import scheduler notifier rsvp-consumer report; do
  run awsl lambda get-function-configuration --function-name $P-$f-fn --query "'{Name:FunctionName,State:State,Role:Role}'"
done
run awsl lambda get-function-configuration --function-name $P-events-fn --query "'Environment.Variables'"

section 10-triggers "Triggers: SQS -> Lambda (3), S3 -> import-fn, EventBridge -> scheduler-fn; resource policies"
run awsl lambda list-event-source-mappings --query "'EventSourceMappings[].{Queue:EventSourceArn,Function:FunctionArn,Batch:BatchSize,State:State}'" --output table
run awsl lambda get-policy --function-name $P-import-fn --query Policy --output text
run awsl lambda get-policy --function-name $P-scheduler-fn --query Policy --output text

section 11-api-gateway "API Gateway: REST API em-api, stage prod, 18 routes -> 4 Lambdas; health check end to end"
run awsl apigateway get-rest-apis --query "'items[].{Name:name,Id:id}'"
run awsl apigateway get-resources --rest-api-id $API_ID --limit 500 --query "'items[?resourceMethods].path'"
run awsl apigateway get-stage --rest-api-id $API_ID --stage-name $STAGE --query "'{Stage:stageName,Deployment:deploymentId}'"
run awsl lambda get-policy --function-name $P-events-fn --query Policy --output text
run curl -s -m 60 $API_LOCAL/api/health
run "curl -s -o /dev/null -w 'unknown path -> HTTP %{http_code}\n' $API_LOCAL/api/not-a-route"
run "curl -s -o /dev/null -w 'events without login -> HTTP %{http_code}\n' $API_LOCAL/api/events"

section 12-website "Website on S3 (em-frontend), config.js points at API Gateway; public link"
run "curl -s -H 'Host: $P-frontend.s3-website-$REGION.localhost' $ENDPOINT/ | head -12"
run "awsl s3 cp s3://$P-frontend/shared/config.js - | grep -E 'API_BASE_URL|TURNSTILE_SITE_KEY'"
note "Local website:  $LOCAL_WEB/"
note "Public website: ${PUBLIC_WEB:-(no tunnel running)}"

section 13-scripts "The scripts that built everything (one per service, like Lab 8)"
run ls -1 infra/services infra/run-floci.sh infra/check.sh infra/evidence.sh infra/zip-lambda.js infra/web-proxy.js

cp infra/evidence-README.md "$OUT/README.md" 2>/dev/null
node -e "const fs=require('fs');const Z=require('adm-zip');const z=new Z();z.addLocalFolder('$OUT','cloud-evidence');if(fs.existsSync('docs/evidence/screenshots'))z.addLocalFolder('docs/evidence/screenshots','cloud-evidence/screenshots');z.writeZip('docs/evidence/cloud-evidence.zip');"
echo; echo "Done: docs/evidence/cloud-evidence.zip  ($(ls $OUT | wc -l) files)"
