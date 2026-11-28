#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run

queue_arn() { awsl sqs get-queue-attributes --queue-url "$1" --attribute-names QueueArn --query Attributes.QueueArn --output text; }

for Q in $P-rsvp-events $P-checkin-events $P-notifications; do
  step "Queue $Q (+ $Q-dlq)"

  DLQ_URL=$(awsl sqs create-queue --queue-name $Q-dlq --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
  DLQ_ARN=$(queue_arn "$DLQ_URL")
  ok "$Q-dlq (keeps failed messages 14 days)"

  QUEUE_URL=$(awsl sqs create-queue --queue-name $Q --query QueueUrl --output text)
  cat > infra/.run/attrs.json <<JSON
{
  "VisibilityTimeout": "180",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
JSON
  awsl sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes file://infra/.run/attrs.json
  ok "$Q (visibility 180 s, 5 tries then $Q-dlq)"
done

rm -rf infra/.run
echo
echo "Check:  awsl sqs list-queues"
