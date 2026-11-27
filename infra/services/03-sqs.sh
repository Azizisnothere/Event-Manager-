#!/usr/bin/env bash
# Service 3: Amazon SQS - three work queues, each with a dead-letter queue (DLQ).
#   em-rsvp-events     (Abdelaziz) capacity changes, cancellations, revoked invitations -> rsvp-consumer-fn
#   em-checkin-events  (Adham)     event completed -> report-fn makes the attendance CSV
#   em-notifications   (Abdelaziz) emails waiting to be sent -> notifier-fn
# A message that fails 5 times moves to <queue>-dlq and is kept 14 days, so nothing is lost.
# Run: bash infra/services/03-sqs.sh      (safe to run again)
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run                      # temporary JSON files (deleted at the end)

queue_arn() { awsl sqs get-queue-attributes --queue-url "$1" --attribute-names QueueArn --query Attributes.QueueArn --output text; }

for Q in $P-rsvp-events $P-checkin-events $P-notifications; do
  step "Queue $Q (+ $Q-dlq)"

  # 1. the dead-letter queue: keeps failed messages for 14 days (1209600 seconds)
  DLQ_URL=$(awsl sqs create-queue --queue-name $Q-dlq --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
  DLQ_ARN=$(queue_arn "$DLQ_URL")
  ok "$Q-dlq (keeps failed messages 14 days)"

  # 2. the work queue: 180 s to process a message; after 5 failed tries -> DLQ
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
