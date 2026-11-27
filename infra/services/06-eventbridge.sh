#!/usr/bin/env bash
# Service 6: Amazon EventBridge - rule em-scheduler-every-5-min  (Osama)
#   A timer: every 5 minutes it runs em-scheduler-fn, which closes RSVPs at the
#   deadline and marks finished events as completed.
#   The target (the Lambda) is connected in step 10, after the Lambda exists.
# Run: bash infra/services/06-eventbridge.sh      (safe to run again)
set -e
source "$(dirname "$0")/_lib.sh"

step "EventBridge rule $P-scheduler-every-5-min"
RULE_ARN=$(awsl events put-rule --name $P-scheduler-every-5-min \
  --schedule-expression 'rate(5 minutes)' --state ENABLED --query RuleArn --output text)
ok "rule $RULE_ARN (rate 5 minutes)"
echo
echo "Check:  awsl events describe-rule --name $P-scheduler-every-5-min"
