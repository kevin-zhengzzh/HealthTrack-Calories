#!/bin/sh
# Daily database dump, keeps the last 14. Run from cron, e.g.:
#   0 3 * * * /root/HealthTrack-Calories/deploy/vps/backup.sh
set -eu
cd "$(dirname "$0")"
mkdir -p backups
docker compose exec -T db pg_dump -U healthtrack -d healthtrack | gzip > "backups/healthtrack-$(date +%F).sql.gz"
ls -1t backups/*.sql.gz | tail -n +15 | xargs -r rm --
