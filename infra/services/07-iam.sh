#!/usr/bin/env bash
# Service 7: AWS IAM - one role ("badge") per Lambda function, like Lab 7.
#   Trust policy  (WHO may wear the badge): only the Lambda service
#                 -> infra/iam/lambda-trust-policy.json
#   Permissions   (WHAT the badge opens): written BY THE TEAM, one file per function
#                 -> infra/iam/policies/<function>.json   (see infra/iam/PERMISSIONS.md)
#   This script only creates the roles and attaches the team's files. A missing
#   policy file gives a warning: Floci does not check IAM unless IAM_ENFORCEMENT=true.
# Run: bash infra/services/07-iam.sh      (safe to run again; re-run after editing a policy)
set -e
source "$(dirname "$0")/_lib.sh"
FUNCTIONS="auth events rsvp checkin import scheduler notifier rsvp-consumer report"

step "IAM roles (one per function, least privilege)"
for f in $FUNCTIONS; do
  FN=$P-$f-fn; ROLE=$FN-role
  if awsl iam get-role --role-name $ROLE >/dev/null 2>&1; then skip "role $ROLE"
  else
    awsl iam create-role --role-name $ROLE \
      --assume-role-policy-document file://infra/iam/lambda-trust-policy.json >/dev/null
    ok "role $ROLE (only lambda.amazonaws.com may assume it)"
  fi
  if [ -f infra/iam/policies/$FN.json ]; then
    awsl iam put-role-policy --role-name $ROLE --policy-name $FN-policy \
      --policy-document file://infra/iam/policies/$FN.json
    ok "  $FN-policy attached from infra/iam/policies/$FN.json"
  else
    echo "  [!!] infra/iam/policies/$FN.json is missing: $ROLE has no permissions yet (team writes it)"
  fi
done
echo
echo "Check:  awsl iam list-roles --query 'Roles[].RoleName'"
