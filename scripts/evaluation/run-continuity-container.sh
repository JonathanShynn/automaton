#!/bin/bash
set -euo pipefail
umask 077

if [[ $# != 1 || ! "$1" =~ ^(1|2|3|verify)$ ]]; then
  echo 'CONTINUITY_PHASE_INVALID' >&2
  exit 1
fi
phase="$1"
network_args=()
model_args=()
trial_args=(--verify)
if [[ "$phase" == verify ]]; then
  network_args=(--network none)
else
  model_args=(--env GEMINI_API_KEY --env GEMINI_MODEL --env GEMINI_FREE_TIER_CONFIRMED
    --env GEMINI_CONTINUITY_TRIAL_APPROVED --env GEMINI_BUDGET_POLICY_JSON)
  trial_args=(--cycle "$phase")
fi

# All raw output stays on the ephemeral runner; only the separate allowlisted
# summary step can print evidence. Neither state nor logs become artifacts.
timeout --kill-after=10s 90s docker run --rm --name automaton-gemini-continuity \
  "${network_args[@]}" --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 64 \
  --mount "type=bind,source=$RUNNER_TEMP/gemini-continuity-state,target=/state" \
  --env GEMINI_BUDGET_DB_PATH "${model_args[@]}" \
  --entrypoint /usr/local/bin/node automaton-gemini-continuity \
  dist/evaluation/gemini-continuity-trial.js "${trial_args[@]}" \
  > "$RUNNER_TEMP/gemini-continuity-$phase.log" 2>&1
