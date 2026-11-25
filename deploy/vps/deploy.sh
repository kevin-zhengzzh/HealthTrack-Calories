#!/bin/sh
# Rolls the server out to the images of one commit (tag = short commit SHA,
# built and pushed by .github/workflows/deploy.yml).
#
# GitHub Actions calls this over SSH with a key that may run nothing else
# (forced command in /root/.ssh/authorized_keys); the tag arrives in
# SSH_ORIGINAL_COMMAND. By hand, e.g. to roll back:
#   ./deploy.sh <commit-sha>
#
# The braces make the shell read the whole script before running it, because
# `git pull` below may replace this file while it runs.
{
set -eu

TAG="${1:-${SSH_ORIGINAL_COMMAND:-}}"
case "$TAG" in
  "" | *[!0-9a-f]*)
    echo "usage: deploy.sh <commit-sha>" >&2
    exit 2 ;;
esac
if [ "${#TAG}" -lt 7 ] || [ "${#TAG}" -gt 40 ]; then
  echo "deploy.sh: not a commit SHA: $TAG" >&2
  exit 2
fi

cd "$(dirname "$0")"

# Latest compose.yml / Caddyfile from main.
git -C ../.. pull --ff-only -q

# Remember the tag, so later manual `docker compose` commands and reboots use
# the same images.
if grep -q '^TAG=' .env; then
  sed -i "s/^TAG=.*/TAG=$TAG/" .env
else
  echo "TAG=$TAG" >> .env
fi

docker compose pull -q backend frontend
docker compose up -d --remove-orphans
docker image prune -f > /dev/null

echo "deployed $TAG"
exit 0
}
