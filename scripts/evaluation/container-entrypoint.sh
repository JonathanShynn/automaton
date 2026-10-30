#!/bin/sh
set -eu

evaluation_config=$(mktemp /tmp/automaton-evaluation-XXXXXX.config.ts)
cp /app/scripts/evaluation/vitest.config.ts "$evaluation_config"
exec python3 /app/scripts/evaluation/run-offline.py \
  /usr/local/bin/node /app/node_modules/vitest/vitest.mjs run \
  --config "$evaluation_config"
