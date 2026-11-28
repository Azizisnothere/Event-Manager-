#!/usr/bin/env bash
set -e
source "$(dirname "$0")/_lib.sh"
API_NAME=$P-api

step "REST API $API_NAME"
API_ID=$(awsl apigateway get-rest-apis --query "items[?name=='$API_NAME'].id | [0]" --output text)
if [ -z "$API_ID" ] || [ "$API_ID" = None ]; then
  API_ID=$(awsl apigateway create-rest-api --name $API_NAME --description "Event Manager API" \
    --endpoint-configuration types=REGIONAL --query id --output text)
  ok "created $API_NAME ($API_ID)"
else skip "$API_NAME ($API_ID)"; fi

res_id() { awsl apigateway get-resources --rest-api-id $API_ID --limit 500 --query "items[?path=='$1'].id | [0]" --output text; }
ensure_path() {
  local p=$1 id parent part
  id=$(res_id "$p")
  if [ -n "$id" ] && [ "$id" != None ]; then echo "$id"; return; fi
  parent=${p%/*}; [ -z "$parent" ] && parent=/
  part=${p##*/}
  awsl apigateway create-resource --rest-api-id $API_ID --parent-id "$(ensure_path "$parent")" \
    --path-part "$part" --query id --output text
}

step "Routes (path -> Lambda)"
while read -r PATH_ SVC; do
  RID=$(ensure_path "$PATH_")
  awsl apigateway get-method --rest-api-id $API_ID --resource-id $RID --http-method ANY >/dev/null 2>&1 || \
    awsl apigateway put-method --rest-api-id $API_ID --resource-id $RID --http-method ANY --authorization-type NONE >/dev/null
  awsl apigateway put-integration --rest-api-id $API_ID --resource-id $RID --http-method ANY \
    --type AWS_PROXY --integration-http-method POST \
    --uri arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/arn:aws:lambda:$REGION:$ACCOUNT:function:$P-$SVC-fn/invocations >/dev/null
  ok "ANY $PATH_  ->  $P-$SVC-fn"
done <<'LIST'
/api/health auth
/api/auth/{proxy+} auth
/api/staff events
/api/staff/{proxy+} events
/api/events events
/api/events/{eventId} events
/api/events/{eventId}/{proxy+} events
/api/invitations/{token}/plus-one-requests events
/api/invitations/{token} rsvp
/api/invitations/{token}/rsvp rsvp
/api/events/{eventId}/rsvps rsvp
/api/events/{eventId}/rsvps/{proxy+} rsvp
/api/events/{eventId}/waitlist rsvp
/api/events/{eventId}/capacity rsvp
/api/events/{eventId}/door-list checkin
/api/events/{eventId}/check-ins checkin
/api/events/{eventId}/check-ins/{proxy+} checkin
/api/events/{eventId}/attendance/{proxy+} checkin
LIST

step "Publish (stage $STAGE) and allow API Gateway to call the 4 API functions"
awsl apigateway create-deployment --rest-api-id $API_ID --stage-name $STAGE --description "deploy $(date -u +%FT%TZ)" >/dev/null
for s in auth events rsvp checkin; do
  awsl lambda add-permission --function-name $P-$s-fn --statement-id apigateway-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*/*" >/dev/null 2>&1 || true
done
ok "stage $STAGE deployed"
API_URL=${PUBLIC_API:-$ENDPOINT}/restapis/$API_ID/$STAGE/_user_request_
echo
echo "API:     $API_URL"
echo "Health:  $API_URL/api/health"
echo "Check:   curl -s $API_URL/api/health"
