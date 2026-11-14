#!/bin/sh
# e2e-budget.sh <start-epoch-seconds> <ceiling-minutes>: report how much of the web-e2e ceiling
# (playwright.config.ts globalTimeout, E2E_SUITE_MINUTES in .github/workflows/e2e.yml) a run used.
# Legacy 684: the suite crept from 10 to 11.3 of its 12 minutes one journey at a time, and nobody
# saw it until a PR that only added four tests went red on the ceiling. Every run now writes its
# duration to the job summary, and a run over 70% of the ceiling (less than the 30% margin legacy
# 684 asks for) leaves a warning annotation on the PR that ate the margin. It never fails the job:
# a slow runner is not a regression, and the ceiling itself still stops a run that hangs.
set -eu

start=$1
minutes=$2
now=$(date +%s)
elapsed=$((now - start))
ceiling=$((minutes * 60))
budget=$((ceiling * 70 / 100))
percent=$((elapsed * 100 / ceiling))
line="web-e2e used ${elapsed}s of its ${ceiling}s ceiling (${percent}%; warn above ${budget}s)"

echo "$line"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$line" >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$elapsed" -gt "$budget" ]; then
  echo "::warning title=web-e2e budget (legacy 684)::${line}. Trim or split the slowest specs before raising E2E_SUITE_MINUTES."
fi
