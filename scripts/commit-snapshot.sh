#!/usr/bin/env bash
# Commit a collected snapshot to the default branch as github-actions[bot], only if it
# changed, and report the commit the branch ends up on. Run inside a checkout of that branch
# with credentials that can push.
#
# Env: BRANCH (the default branch), SNAPSHOT (path of the collected file).
# Writes `branch=` and `sha=` to $GITHUB_OUTPUT (or stdout when unset): sha is the pushed
# commit, or the checked-out one when the snapshot did not change.
set -euo pipefail
: "${BRANCH:?}" "${SNAPSHOT:?}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
mkdir -p web/data
cp "$SNAPSHOT" web/data/snapshot.json
git add web/data/snapshot.json
if git diff --cached --quiet; then
  echo "snapshot unchanged; nothing to commit"
else
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git commit -m "data: nightly snapshot $(date -u +%Y-%m-%d)"
  # The branch may have moved while git-koi was compiling: rebase onto it and retry once.
  # Only this file is touched here, so a conflict means someone else wrote it; ours is newer.
  for attempt in 1 2; do
    git fetch origin "$BRANCH"
    git rebase -X theirs "origin/$BRANCH"
    if git push origin "HEAD:refs/heads/$BRANCH"; then
      pushed=1
      break
    fi
    echo "push rejected (attempt $attempt); retrying"
  done
  [[ "${pushed:-}" == 1 ]] || { echo "::error::could not push the snapshot to $BRANCH"; exit 1; }
fi
echo "branch=$BRANCH" >> "$out"
echo "sha=$(git rev-parse HEAD)" >> "$out"
