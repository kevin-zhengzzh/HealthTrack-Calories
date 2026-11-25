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

## Automatic deploys (GitHub Actions)

After CI passes on `main`, [`deploy.yml`](../../.github/workflows/deploy.yml)
builds the images once and rolls them out to Azure and to this server in
parallel:

```
build ──► Docker Hub: backend-<sha>, vps-frontend-<sha>
  └─► vps job ──SSH──► deploy.sh <sha> ──► git pull, docker compose pull + up
          └─► waits for https://DOMAIN/api/health to report version <sha>
```

The server never builds anything; it only pulls images. `TAG` in `.env`
records which commit is running.

**The deploy key can only run `deploy.sh`.** Its line in
`/root/.ssh/authorized_keys` has a forced command, so whatever command the SSH
client asks for, the server runs the script instead (the requested command,
here the tag, is passed in `SSH_ORIGINAL_COMMAND` and must look like a commit
SHA). A leaked key can only redeploy an existing version; it can't open a
shell or forward ports.

One-time setup:

1. Generate a key pair for GitHub (no passphrase) and add the public key on
   the server:

   ```bash
   echo 'command="/root/HealthTrack-Calories/deploy/vps/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy' >> /root/.ssh/authorized_keys
   ```

2. GitHub → Settings → Secrets and variables → Actions:
   - `VPS_HOST`: the server's IP
   - `VPS_SSH_KEY`: the private key (whole file, including the BEGIN/END lines)
   - `VPS_KNOWN_HOSTS`: the server's host key lines, from `ssh-keygen -F <ip>` on
     a machine that has already connected (pins the server, so the job can't be
     tricked into talking to another machine)

## Manual deploys and rollback

```bash
cd ~/HealthTrack-Calories/deploy/vps
./deploy.sh <commit-sha>    # e.g. roll back to an earlier version
```

Every image on Docker Hub is tagged with its commit, so any earlier commit
that was deployed can be rolled back to. To build from source on the server
instead of pulling (e.g. testing a branch):

```bash
TAG=local docker compose up -d --build
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
