#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node infra/teardown.js
