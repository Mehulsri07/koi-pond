#!/usr/bin/env bash
# Resolve the repository's default branch for a scheduled or manual run. A schedule event
# carries no github.event.repository, so ask the API. Writes `branch=<name>` to
# $GITHUB_OUTPUT (or stdout when unset). A manual run must be started from that branch.
#
# Env: GITHUB_REPOSITORY, GH_TOKEN (read access), EVENT_NAME, REF_NAME.
set -euo pipefail
branch=$(gh api "repos/${GITHUB_REPOSITORY}" --jq .default_branch)
if [[ -z "$branch" || "$branch" == "null" ]]; then
  echo "::error::could not resolve the default branch of ${GITHUB_REPOSITORY}"
  exit 1
fi
if [[ "${EVENT_NAME:-}" == "workflow_dispatch" && "${REF_NAME:-}" != "$branch" ]]; then
  echo "::error title=Run from the default branch::This workflow collects and deploys the default branch ($branch), but was started from '${REF_NAME:-}'. Use 'Run workflow' on $branch."
  exit 1
fi
echo "default branch: $branch"
echo "branch=$branch" >> "${GITHUB_OUTPUT:-/dev/stdout}"
