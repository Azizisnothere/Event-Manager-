#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run

step "SNS topic $P-domain-events"
TOPIC_ARN=$(awsl sns create-topic --name $P-domain-events --query TopicArn --output text)
ok "topic $TOPIC_ARN"

subscribe() {
  local Q=$1 FILTER=$2
  local URL ARN
  URL=$(awsl sqs get-queue-url --queue-name $Q --query QueueUrl --output text)
  ARN=$(awsl sqs get-queue-attributes --queue-url "$URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

  cat > infra/.run/qpolicy.json <<JSON
{ "Policy": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$ARN\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$TOPIC_ARN\"}}}]}" }
JSON
  awsl sqs set-queue-attributes --queue-url "$URL" --attributes file://infra/.run/qpolicy.json
  ok "$Q: queue policy allows only $P-domain-events"

  if awsl sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query "Subscriptions[].Endpoint" --output text | grep -q "$ARN"; then
    skip "subscription $P-domain-events -> $Q"; return
  fi
  cat > infra/.run/sub.json <<JSON
{ "RawMessageDelivery": "true", "FilterPolicy": "$(echo "$FILTER" | sed 's/"/\\"/g')" }
JSON
  awsl sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$ARN" \
    --attributes file://infra/.run/sub.json >/dev/null
  ok "subscription $P-domain-events -> $Q  filter $FILTER"
}

step "Subscriptions (fan-out to the queues)"
subscribe $P-rsvp-events    '{"type":["event.capacity_changed","event.updated","event.cancelled","invitation.revoked"]}'
subscribe $P-checkin-events '{"type":["event.completed"]}'

rm -rf infra/.run
echo
echo "Check:  awsl sns list-subscriptions-by-topic --topic-arn $TOPIC_ARN"
