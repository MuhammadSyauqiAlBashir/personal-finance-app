# Financial Management

Household finance PWA for Bashir and his wife: bank emails → pending transactions → confirm with a receipt →
envelope wallets, reports, an AI advisor and push notifications. Live at
https://financial-management.bashir.my.id. Design and every interview decision: [`docs/DESIGN.md`](docs/DESIGN.md).

## Layout

| Path | What |
|---|---|
| `backend/fin/` | FastAPI app (`finance.service`, 127.0.0.1:8100). `main.py` app + auth, `security.py` sessions + Face ID lock, `ingest.py` signed Apps Script endpoints (emails in, receipts out to Drive), `parsers.py` BCA/Mandiri rules, `redact.py` masks account/card numbers before storing or sending to Gemini, `emails.py` pipeline + Gemini fallback, `details.py` read-time "Bank details" card (from/to/fee/refs) for the Inbox, `budget.py` cycles/wallets/sweep/demo, `routes_*.py` API, `receipts.py`, `drive.py` receipts queue for the Apps Script Drive upload, `categorize.py`, `advisor.py`, `reports.py`, `notify.py` Web Push, `scheduler.py` daily jobs, `ai.py` Gemini client |
| `web/` | Static PWA served by Caddy (`/srv/finance`): plain ES modules in `web/js/`, hand-drawn SVG charts (`charts.js`), service worker for offline shell + push |
| `pb_migrations/`, `pb_hooks/` | PocketBase schema (`fin_*`, service-role-only rules) and the `fin-service` CLI command |
| `apps-script/` | Google Apps Script for the finance Gmail (`Code.gs`, runs every 5 min) |
| `deploy/` | systemd unit, Caddy site block, `deploy.sh` |
| `tests/` | Parser and bank-details tests on name-scrubbed real bank emails (`tests/fixtures/`) |
| `docs/` | `DESIGN.md`, `gmail-setup-runbook.md` |

## Operate

- Deploy: `./deploy/deploy.sh` (`SKIP_PB_RESTART=1 ./deploy/deploy.sh` to leave PocketBase running). Then check
  `systemctl is-active pocketbase finance`.
- Tests: `~/work/fin-venv/bin/python -m pytest -q tests`. JS syntax: copy to `.mjs`, `node --check`.
- Logs: `sudo journalctl -u finance -n 100 --no-pager` (every push is logged with Apple's status code).
- Secrets: `/etc/finance/env` (`root:finance 0640`): `GEMINI_API_KEY`, `FIN_INGEST_SECRET`,
  `FIN_PB_SERVICE_USER`, `FIN_PB_SERVICE_PASSWORD`, `FIN_LOCK_IDLE_SECONDS` (Face ID lock, 3600). State in
  `/var/lib/finance`: VAPID key `vapid_private.pem`, unlocked lock sessions `lock_sessions.json`.
- Settings stored in `fin_kv`: `profile`, `cycle` (start day, currently 28), `tracking_start`, `holders`,
  `account_owners` ("Whose account?" in the Inbox, e.g. `{"BCA:73": username}`), `setup_done`, and `demo_periods`
  only while demo data exists.
- **The app is live with real money data: ask the owner before changing any `fin_*` record or setting.**
- Household members: Settings → Members (admin), or `fin_members`. Accounts are the shared PocketBase `users`
  (register/approve in lyrsync).

## Gotchas learned

- Gemini free tier: ask for money as strings, mark every field required with `propertyOrdering`, don't set
  temperature on Gemini 3 models (they loop), and expect 503 spikes (wide fallback list in `ai.py`).
- Web Push to iPhone needs `Urgency: high` or iOS may hold it until the app opens.
- iOS PWAs often fail the first request after a long sleep (stale connection): the front end retries GETs.
- Deploys must not touch `pb_hooks` needlessly: PocketBase runs with `--hooksWatch=false` and `Restart=always`.
