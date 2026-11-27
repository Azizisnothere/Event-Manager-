#!/usr/bin/env bash
# infra/deploy.sh  Deploys Event Manager to Floci (design 3.5). Same as: npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."
node infra/deploy.js
