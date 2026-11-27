#!/usr/bin/env bash
# Service 5: AWS Secrets Manager - the app's secrets, read from .env  [Threat 8]
#   em/db-url            Neon connection for the restricted em_app user   (shared)
#   em/jwt-secret        signs login tokens                               (Abdelaziz)
#   em/turnstile-secret  Cloudflare bot check                             (Abdelaziz)
#   em/geoapify-api-key  address lookup                                   (Osama)
#   em/brevo-api-key     sending emails                                   (Osama)
# The Lambdas only get the secret NAMES as settings; they read the values at run time
# with their IAM role. No secret is ever written in the code or in a Lambda setting.
# The values are never printed.
# Run: bash infra/services/05-secrets.sh      (safe to run again; updates the values)
set -e
source "$(dirname "$0")/_lib.sh"
[ -f .env ] || { echo ".env not found: run this from the project folder"; exit 1; }
mkdir -p infra/.run

# read KEY from .env (strip quotes and Windows line endings)
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

put_secret() {
  local NAME=$1 VALUE=$2
  if [ -z "$VALUE" ]; then VALUE=not-configured; echo "  [!!] $NAME: no value in .env, stored as not-configured"; fi
  printf '%s' "$VALUE" > infra/.run/secret.txt
  if awsl secretsmanager describe-secret --secret-id "$NAME" >/dev/null 2>&1; then
    awsl secretsmanager put-secret-value --secret-id "$NAME" --secret-string file://infra/.run/secret.txt >/dev/null
    ok "$NAME updated"
  else
    awsl secretsmanager create-secret --name "$NAME" --secret-string file://infra/.run/secret.txt >/dev/null
    ok "$NAME created"
  fi
}

step "Secrets Manager (values from .env, never printed)"
put_secret $P/db-url            "$(envval DATABASE_URL)"
put_secret $P/jwt-secret        "$(envval JWT_SECRET)"
put_secret $P/turnstile-secret  "$(envval TURNSTILE_SECRET_KEY)"
put_secret $P/geoapify-api-key  "$(envval GEOAPIFY_API_KEY)"
put_secret $P/brevo-api-key     "$(envval BREVO_API_KEY)"

rm -rf infra/.run
echo
echo "Check:  awsl secretsmanager list-secrets --query 'SecretList[].Name'"
