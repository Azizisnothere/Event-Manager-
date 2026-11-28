#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
for s in 01-s3 02-dynamodb 03-sqs 04-sns 05-secrets 06-eventbridge 07-iam 08-cloudwatch 09-lambda 10-triggers 11-api-gateway 12-website; do
  echo; echo "################ $s ################"
  bash infra/services/$s.sh
done
echo; echo "All services built. Now run:  bash infra/check.sh"
