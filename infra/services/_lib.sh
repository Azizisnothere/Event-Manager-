export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_REGION=us-east-1
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1

ENDPOINT=http://localhost:4566
REGION=us-east-1
P=em

awsl() { aws --endpoint-url "$ENDPOINT" --region "$REGION" "$@"; }

STAGE=prod
RUNTIME=nodejs22.x
LAMBDA_AWS_ENDPOINT=http://floci:4566

envval() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

LOCAL_WEB="http://$P-frontend.s3-website-$REGION.localhost:4566"
PUBLIC_WEB=$(envval PUBLIC_WEB_URL | sed 's#/*$##')
PUBLIC_API=$(envval PUBLIC_API_URL | sed 's#/*$##')
WEB_URL=${PUBLIC_WEB:-$LOCAL_WEB}

ok()   { echo "  [ok] $*"; }
skip() { echo "  [--] $* (already exists, skipping)"; }
step() { echo; echo "== $*"; }

if ! awsl sts get-caller-identity >/dev/null 2>&1; then
  echo "Floci is not reachable at $ENDPOINT. Start it: docker compose -f infra/floci/docker-compose.yml up -d"
  return 1 2>/dev/null || exit 1
fi
ACCOUNT=$(awsl sts get-caller-identity --query Account --output text)
echo "Floci ready: account $ACCOUNT, region $REGION (awsl = aws on Floci)"
