#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
mkdir -p infra/.run
NS=EventManager/Security

step "Log groups (14 days)"
for f in auth events rsvp checkin import scheduler notifier rsvp-consumer report; do
  G=/aws/lambda/$P-$f-fn
  awsl logs create-log-group --log-group-name $G 2>/dev/null && ok "log group $G" || skip "log group $G"
  awsl logs put-retention-policy --log-group-name $G --retention-in-days 14 2>/dev/null || true
done

step "Security metric filters ($NS)"
while read -r METRIC EVENT FNS; do
  for f in $FNS; do
    cat > infra/.run/filter.json <<JSON
{ "logGroupName": "/aws/lambda/$P-$f-fn", "filterName": "$P-$EVENT",
  "filterPattern": "\"$EVENT\"",
  "metricTransformations": [ { "metricName": "$METRIC", "metricNamespace": "$NS", "metricValue": "1", "defaultValue": 0 } ] }
JSON
    awsl logs put-metric-filter --cli-input-json file://infra/.run/filter.json
  done
  ok "$METRIC  <- \"$EVENT\" lines in: $FNS"
done <<'LIST'
FailedLogins login_failed auth
LockedAccounts login_locked auth
AccessDenied access_denied auth events rsvp checkin
Unauthenticated auth_failed auth events rsvp checkin
RateLimited rate_limited auth events rsvp
TurnstileFailed turnstile_failed rsvp
LIST

step "Alarms -> SNS topic $P-security-alerts"
ALERT_TOPIC=$(awsl sns create-topic --name $P-security-alerts --query TopicArn --output text)
while read -r NAME METRIC THRESHOLD DESC; do
  cat > infra/.run/alarm.json <<JSON
{ "AlarmName": "$NAME", "AlarmDescription": "$DESC", "Namespace": "$NS", "MetricName": "$METRIC",
  "Statistic": "Sum", "Period": 300, "EvaluationPeriods": 1, "Threshold": $THRESHOLD,
  "ComparisonOperator": "GreaterThanOrEqualToThreshold", "TreatMissingData": "notBreaching",
  "AlarmActions": ["$ALERT_TOPIC"] }
JSON
  awsl cloudwatch put-metric-alarm --cli-input-json file://infra/.run/alarm.json
  ok "alarm $NAME: $METRIC >= $THRESHOLD in 5 min"
done <<'LIST'
em-repeated-failed-logins FailedLogins 5 5 or more failed logins in 5 minutes: possible password guessing (Threat 1)
em-repeated-access-denied AccessDenied 10 10 or more 403 responses in 5 minutes: someone probing other users records (Threat 3)
LIST

rm -rf infra/.run
echo
echo "Check:  awsl cloudwatch describe-alarms --query 'MetricAlarms[].[AlarmName,StateValue]' --output table"
