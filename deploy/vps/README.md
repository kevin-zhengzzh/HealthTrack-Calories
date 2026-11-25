# Self-hosted deployment (single VPS)

A second, independent deployment of HealthTrack on one Linux server, alongside
the Azure one (which is unchanged). Everything runs in Docker Compose:

```
Internet ──443/80──► Caddy ──/api/*──► backend (.NET, :5000) ──► db (Postgres)
                          └─ else ───► frontend (nginx serving the React build)
```

- **Caddy** gets and renews a Let's Encrypt certificate for the domain
  automatically and redirects HTTP to HTTPS.
- Site and API share one origin (`https://DOMAIN` and `https://DOMAIN/api`), so
  no CORS is involved.
- Only ports 22, 80 and 443 are open. Postgres is not reachable from outside.
- The database starts empty; migrations run when the backend starts.
- Stack-chan devices keep talking to the Azure backend. Pointing one at this
  server needs the Let's Encrypt root (ISRG Root X1) in
  `firmware/stackchan-scale/include/root_ca.h`.

## First-time setup

Server: Ubuntu 24.04, 2 GB RAM (DigitalOcean, Sydney). DNS: an `A` record for
`@` (and `www`) pointing at the server's IPv4 address, **DNS only** (grey cloud
in Cloudflare).

```bash
# On the server, as root
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh

# Firewall
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Swap, so building the images doesn't run out of memory
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Code and configuration
git clone https://github.com/kevin-zhengzzh/HealthTrack-Calories.git
cd HealthTrack-Calories/deploy/vps
cp .env.example .env
nano .env        # DOMAIN, and generate secrets with: openssl rand -base64 48

docker compose up -d --build
docker compose logs -f caddy backend   # wait for "certificate obtained successfully"
```

Then open `https://DOMAIN` and register a new account.

## Updating

```bash
cd HealthTrack-Calories && git pull
cd deploy/vps && docker compose up -d --build
docker image prune -f
```

## Backups

`backup.sh` dumps the database to `backups/` and keeps the last 14 days.

```bash
crontab -e
# 0 3 * * * /root/HealthTrack-Calories/deploy/vps/backup.sh
```

Restore: `gunzip -c backups/<file>.sql.gz | docker compose exec -T db psql -U healthtrack -d healthtrack`
(into an empty database). Backups live on the same server, so copy them
elsewhere from time to time (`scp`).

## Useful commands

```bash
docker compose ps                    # what is running
docker compose logs -f backend       # backend logs
docker compose exec db psql -U healthtrack -d healthtrack   # SQL shell
dig +short DOMAIN                    # check DNS points at this server
```
