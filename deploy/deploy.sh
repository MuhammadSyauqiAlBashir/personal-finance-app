#!/usr/bin/env bash
# Deploy Financial Management from this repo. Safe to re-run.
#   backend  -> /opt/finance (root-owned, runs as user `finance`)
#   web      -> /srv/finance (static, served by Caddy)
#   pb files -> /var/lib/pocketbase/{pb_migrations,pb_hooks} (applied on PocketBase restart)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M%S)"
echo "==> finance $VERSION"

id finance >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin finance

echo "==> backend"
sudo install -d -o root -g root -m 755 /opt/finance
[ -x /opt/finance/venv/bin/python ] || sudo python3 -m venv /opt/finance/venv
sudo /opt/finance/venv/bin/pip install --quiet --disable-pip-version-check -r backend/requirements.txt
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 --exclude __pycache__ backend/fin/ /opt/finance/fin/
sudo install -o root -g root -m 644 deploy/finance.service /etc/systemd/system/finance.service
sudo chown root:finance /etc/finance /etc/finance/env
sudo chmod 750 /etc/finance
sudo chmod 640 /etc/finance/env

echo "==> web"
STAGE="$(mktemp -d)"
trap 'rm -rf -- "$STAGE"' EXIT
cp -r web/. "$STAGE/"
{ grep -rl __VERSION__ "$STAGE" || true; } | xargs -r sed -i "s/__VERSION__/$VERSION/g"
sudo install -d -o root -g root -m 755 /srv/finance
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 "$STAGE/" /srv/finance/

echo "==> pocketbase migrations + hooks"
sudo install -C -o pocketbase -g pocketbase -m 640 pb_migrations/*.js /var/lib/pocketbase/pb_migrations/
sudo install -C -o pocketbase -g pocketbase -m 640 pb_hooks/*.js /var/lib/pocketbase/pb_hooks/

echo "==> restart"
sudo systemctl daemon-reload
if [ "${SKIP_PB_RESTART:-0}" != 1 ]; then sudo systemctl restart pocketbase; sleep 2; fi
sudo systemctl enable --quiet finance
sudo systemctl restart finance
for i in $(seq 30); do curl -fsS http://127.0.0.1:8100/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8100/api/health && echo
echo "==> done: $VERSION"
