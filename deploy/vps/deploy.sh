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

# Caddy only reads the Caddyfile when its container starts, and `up` doesn't
# recreate it for a changed file. When the Caddyfile differs from the one last
# applied, validate it first (a typo would take the whole site down), then
# recreate Caddy. Certificates live in a volume, so nothing is re-issued.
applied=.caddyfile-applied
current=$(sha256sum Caddyfile | cut -d' ' -f1)
if [ "$current" != "$(cat "$applied" 2>/dev/null || true)" ]; then
  docker compose run --rm --no-deps caddy \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  docker compose up -d --no-deps --force-recreate caddy
  echo "$current" > "$applied"
  echo "Caddy reloaded with the new Caddyfile"
fi

docker image prune -f > /dev/null

echo "deployed $TAG"
exit 0
}
