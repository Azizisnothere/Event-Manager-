#!/usr/bin/env bash
# infra/teardown.sh  Removes everything deploy.sh created. Same as: npm run teardown
set -euo pipefail
cd "$(dirname "$0")/.."
node infra/teardown.js
