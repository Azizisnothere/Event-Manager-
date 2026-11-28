#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"

step "EventBridge rule $P-scheduler-every-5-min"
RULE_ARN=$(awsl events put-rule --name $P-scheduler-every-5-min \
  --schedule-expression 'rate(5 minutes)' --state ENABLED --query RuleArn --output text)
ok "rule $RULE_ARN (rate 5 minutes)"
echo
echo "Check:  awsl events describe-rule --name $P-scheduler-every-5-min"
