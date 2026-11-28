#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run
fn_arn() { echo arn:aws:lambda:$REGION:$ACCOUNT:function:$P-$1-fn; }
allow() { awsl lambda add-permission --function-name $1 --statement-id $2 --action lambda:InvokeFunction \
            --principal $3 --source-arn $4 >/dev/null 2>&1 || true; }

step "SQS -> Lambda"
while read -r Q F; do
  QURL=$(awsl sqs get-queue-url --queue-name $P-$Q --query QueueUrl --output text)
  QARN=$(awsl sqs get-queue-attributes --queue-url "$QURL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
  if awsl lambda list-event-source-mappings --function-name $P-$F-fn --query 'EventSourceMappings[].EventSourceArn' --output text | grep -q "$QARN"; then
    skip "$P-$Q -> $P-$F-fn"
  else
    awsl lambda create-event-source-mapping --function-name $P-$F-fn --event-source-arn "$QARN" \
      --batch-size 10 --function-response-types ReportBatchItemFailures --enabled >/dev/null
    ok "$P-$Q -> $P-$F-fn"
  fi
done <<'LIST'
rsvp-events rsvp-consumer
checkin-events report
notifications notifier
LIST

step "S3 -> Lambda (guest-list import)"
allow $P-import-fn s3-imports s3.amazonaws.com arn:aws:s3:::$P-guest-imports
cat > infra/.run/notify.json <<JSON
{ "LambdaFunctionConfigurations": [ {
    "LambdaFunctionArn": "$(fn_arn import)",
    "Events": ["s3:ObjectCreated:*"],
    "Filter": { "Key": { "FilterRules": [ { "Name": "prefix", "Value": "imports/" }, { "Name": "suffix", "Value": ".csv" } ] } }
} ] }
JSON
awsl s3api put-bucket-notification-configuration --bucket $P-guest-imports --notification-configuration file://infra/.run/notify.json
ok "new file em-guest-imports/imports/*.csv -> $P-import-fn"

step "EventBridge -> Lambda (every 5 minutes)"
RULE_ARN=$(awsl events describe-rule --name $P-scheduler-every-5-min --query Arn --output text)
allow $P-scheduler-fn eventbridge-schedule events.amazonaws.com "$RULE_ARN"
awsl events put-targets --rule $P-scheduler-every-5-min --targets "Id=scheduler,Arn=$(fn_arn scheduler)" >/dev/null
ok "$P-scheduler-every-5-min -> $P-scheduler-fn"

rm -rf infra/.run
echo
echo "Check:  awsl lambda list-event-source-mappings --query 'EventSourceMappings[].[EventSourceArn,FunctionArn,State]' --output table"
