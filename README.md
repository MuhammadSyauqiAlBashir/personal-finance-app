# Financial Management

Household finance PWA for Bashir and his wife: bank emails → pending transactions → confirm with a receipt →
envelope wallets, reports, an AI advisor and push notifications. Live at
https://financial-management.bashir.my.id. Design and every interview decision: [`docs/DESIGN.md`](docs/DESIGN.md).

## Layout

| Path | What |
|---|---|
| `backend/fin/` | FastAPI app (`finance.service`, 127.0.0.1:8100). `main.py` app + auth, `security.py` sessions + Face ID lock, `ingest.py` signed Apps Script endpoints (emails in, receipts out to Drive), `parsers.py` BCA/Mandiri rules, `emails.py` pipeline + Gemini fallback, `budget.py` cycles/wallets/sweep/demo, `routes_*.py` API, `receipts.py`, `categorize.py`, `advisor.py`, `reports.py`, `notify.py` Web Push, `scheduler.py` daily jobs, `ai.py` Gemini client |
| `web/` | Static PWA served by Caddy (`/srv/finance`): plain ES modules in `web/js/`, hand-drawn SVG charts (`charts.js`), service worker for offline shell + push |
| `pb_migrations/`, `pb_hooks/` | PocketBase schema (`fin_*`, service-role-only rules) and the `fin-service` CLI command |
| `apps-script/` | Google Apps Script for the finance Gmail (`Code.gs`, runs every 5 min) |
| `deploy/` | systemd unit, Caddy site block, `deploy.sh` |
| `tests/` | Parser tests on name-scrubbed real bank emails (`tests/fixtures/`) |
| `docs/` | `DESIGN.md`, `gmail-setup-runbook.md` |

## Operate

- Deploy: `./deploy/deploy.sh` (`SKIP_PB_RESTART=1 ./deploy/deploy.sh` to leave PocketBase running). Then check
  `systemctl is-active pocketbase finance`.
- Tests: `~/work/fin-venv/bin/python -m pytest -q tests`. JS syntax: copy to `.mjs`, `node --check`.
- Logs: `sudo journalctl -u finance -n 100 --no-pager` (every push is logged with Apple's status code).
- Secrets: `/etc/finance/env` (`root:finance 0640`): `GEMINI_API_KEY`, `FIN_INGEST_SECRET`,
  `FIN_PB_SERVICE_USER`, `FIN_PB_SERVICE_PASSWORD`. VAPID key: `/var/lib/finance/vapid_private.pem`.
- Settings stored in `fin_kv`: `profile`, `cycle` (start day), `tracking_start`, `holders`, `demo_periods`,
  `setup_done`.
- Household members: Settings → Members (admin), or `fin_members`. Accounts are the shared PocketBase `users`
  (register/approve in lyrsync).

## Gotchas learned

- Gemini free tier: ask for money as strings, mark every field required with `propertyOrdering`, don't set
  temperature on Gemini 3 models (they loop), and expect 503 spikes (wide fallback list in `ai.py`).
- Web Push to iPhone needs `Urgency: high` or iOS may hold it until the app opens.
- iOS PWAs often fail the first request after a long sleep (stale connection): the front end retries GETs.
- Deploys must not touch `pb_hooks` needlessly: PocketBase runs with `--hooksWatch=false` and `Restart=always`.
