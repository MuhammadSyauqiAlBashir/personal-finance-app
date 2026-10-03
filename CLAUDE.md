# Financial Management (finance PWA) — Claude context

Household finance PWA for **Bashir** (owner, username `bashirsyauqi`) and his wife (**bells**). Live at
https://financial-management.bashir.my.id, installed as a Home Screen app on both iPhones. Bank emails → pending
transactions → confirm with a receipt → envelope wallets, reports, AI advisor, push notifications.

Read before deeper work: `README.md` (layout, operate, gotchas) and `docs/DESIGN.md` (every interview decision,
data model, flows; §11 changes after the first build). Server-wide facts (VPS, Caddy, PocketBase, security,
backups) are in `~/.claude/CLAUDE.md`.

## Rules for working on this app (owner's instructions)

- **The app is LIVE with real money data (since 2026-10-01). ALWAYS ask Bashir before changing any data** —
  PocketBase `fin_*` records, `fin_kv` settings, migrations that touch existing rows, re-parsing that rewrites stored
  emails/transactions — and explain exactly what changes and what it affects. Owner's words: "from now on since this
  already online, you need to ALWAYS confirm to me if you want to change data and explain me what will it impacted."
  Code/UI changes and read-only checks are fine. Prefer computing extra info at read time (like `fin/details.py`)
  over rewriting stored records.
- Never print secrets (Gemini key, ingest HMAC secret, service password) into chat or commits.
- Owner prefers step-by-step, click-by-click guidance; budget-conscious; highest reasonable security.
- Git: work on `develop`; commit with `-c user.name="Bashir" -c user.email="bashirsyauqi@gmail.com"`. Push to
  `origin/develop` only when the owner asks (he asked on 2026-10-03). No PRs to `main` unless asked.
- After every deploy: `systemctl is-active pocketbase finance` (a PocketBase outage happened once).
- Keep working files in `~/work/` (`/tmp` is wiped on reboot).

## Server facts

| Item | Value |
|---|---|
| Backend | `finance.service` (FastAPI/uvicorn), user `finance`, 127.0.0.1:8100, sandboxed (score ~1.2), ~80 MB RAM |
| Code on server | `/opt/finance` (+ `venv`), static web `/srv/finance`, state `/var/lib/finance` (VAPID key, `lock_sessions.json`) |
| Secrets | `/etc/finance/env` (`root:finance 0640`): `GEMINI_API_KEY`, `FIN_INGEST_SECRET`, `FIN_PB_SERVICE_USER`, `FIN_PB_SERVICE_PASSWORD`, `FIN_LOCK_IDLE_SECONDS=3600`. Backup `~/work/finance-env.bak-2026-10-01` |
| Data | PocketBase (shared), 21+ `fin_*` collections, rules `role = 'service'` only; service login `svc_finance`; settings in `fin_kv` |
| Caddy | `deploy/Caddyfile.finance` (static `/srv/finance` + `/api/*` → 8100; camera allowed on this site) |
| Gmail | finance inbox `personalfinancemanagementsera@gmail.com`; Apps Script `apps-script/Code.gs` ("Bank email forwarder", trigger `run` every 5 min) sends `bank`/`sample` emails to `/api/ingest/email` (HMAC) and saves confirmed receipts to that account's Drive (`Financial Management/Receipts/YYYY-MM/`). No Google credentials on the server |
| Deploy | `./deploy/deploy.sh` (`SKIP_PB_RESTART=1` to leave PocketBase running); deploy uses `install -C` for pb files |
| Tests | `~/work/fin-venv/bin/python -m pytest -q tests` (parsers + details on scrubbed real emails). JS: copy to `.mjs`, `node --check` (Node 18) |
| Logs | `sudo journalctl -u finance -n 100 --no-pager` (every push logged with Apple's status) |
| Scratch test env | `~/work/fin-scratch.sh` (:8101 → scratch PB `~/work/pb/fin1` on :8093) + `~/work/devproxy.py` :8102; browser checks `~/work/fin_check.py`, `shots*.py`, `race.py` (Playwright in `~/work/fin-venv`) |
| One-off scripts on live DB | write `~/work/x.py`, `sudo install -m 644` to /tmp, run `sudo -u finance bash -c 'set -a; . /etc/finance/env; set +a; cd /opt/finance && PYTHONPATH=/opt/finance /opt/finance/venv/bin/python /tmp/x.py'`, delete it. **Writes need the owner's OK first** |

## How it works (short)

- Modules `backend/fin/`: `parsers.py` (BCA/Mandiri rules), `emails.py` (pipeline + Gemini fallback with amount
  cross-check), `details.py` (read-time "Bank details" card: from/to/amount/fee/refs, unwraps forwarded CRLF emails),
  `budget.py` (cycles, wallets, sweep, demo), `routes_*.py`, `receipts.py`, `reports.py`, `advisor.py`, `notify.py`
  (Web Push, `Urgency: high`), `scheduler.py` (00:05 close+sweep, 09:00 bills, 19:00 pending, 20:00 pace, 21:00
  daily), `security.py` (sessions + Face ID lock), `ai.py` (Gemini, wide model fallback).
- Envelope zero-based budget; cycle start day **1** (kv `cycle`); `tracking_start` = 2026-10-01 (bank tx before it →
  `ignored` with flag `before_tracking_start`; bill/pace/pending/daily pushes wait for it); leftovers sweep to
  emergency fund then goals; e-wallet top-ups are balances accounted by purchases; own-account transfers internal.
- Face ID lock: server-enforced passkey (WebAuthn) lock after **1 hour** away (`FIN_LOCK_IDLE_SECONDS=3600`, owner's
  choice). POST `/api/alive` heartbeat while the user is active (typing never locks); lock shows as an overlay; a 423
  request is re-sent after unlock; unlocked sessions survive restarts (hashed ids in `/var/lib/finance/lock_sessions.json`).
  Face ID starts by itself on the lock screen (iOS 17.4+), but iOS always shows its own passkey sheet needing one
  tap — that can't be removed (researched).
- App frame: no zoom (viewport + gesture blocking), fixed frame using `--app-h` = `screen.height` in standalone
  mode (tab bar on the real bottom edge), Advisor input above the tab bar.
- Inbox: "Bank details" card + "Whose account?" chips → kv `account_owners` {"BCA:73": username}.

## History (newest first)

- 2026-10-01 — Lock after 1 hour; Face ID auto-start; lock sessions persisted; tab bar from `screen.height`;
  typing never locks (heartbeat); no zoom; richer Inbox bank details (`details.py`, 15 tests); Advisor input fix.
- 2026-10-01 — **Clean reset (owner's request):** plan, months, wallets/categories, goals, bill, merchant rules,
  reports, splits, activity log and kv `setup_done`/`profile`/`demo_periods` deleted → setup wizard ran again.
  Kept: bank emails, all 32 transactions (unlinked; the 1 confirmed one back to pending), push subs, passkeys,
  members, kv `cycle` (1), `holders`, `tracking_start`. Backup: `~/work/pb-before-finance-reset-2026-10-01.db` (root 600).
  The owner then finished the real setup.
- 2026-09-27 — Installed on both iPhones, wizard done, push verified on both; October: owner's 3 incomes
  (Rp17.975.000) + 13-wallet plan (later reset). Demo Aug/Sep data created then removed by the owner (feature stays:
  kv `demo_periods`, `DELETE /api/demo`, Settings → Demo data). Optional note on confirm; optional wallet on Add;
  high-urgency pushes; GET retries after long sleep; machine-login roles rejected at login.
- 2026-09-26 — Built and deployed (all milestones). Owner interview → `docs/DESIGN.md`. Gmail setup done.

## Gemini (shared free quota)

Free tier, key copied to the shop and games too, so the per-model daily quota (resets 14:00 WIB) is shared by
finance, the shop and BashGames. Finance needs Gemini only for unknown email formats, receipt photos and the
advisor; BCA/Mandiri emails are parsed by rules. Bank text is redacted before sending. Lessons: money fields as
strings, all fields required + `propertyOrdering`, no temperature on Gemini 3 (loops), 503 spikes common,
`gemini-2.5-*` retired (404).

## Open owner tasks (remind at session start, tick off when confirmed)

- [ ] Real go-live test: a small BCA/Mandiri payment on/after 1 Oct → push on both phones → attach receipt →
      confirm → check the receipt in Drive.
- [ ] Wife's bank-email forwarding (click-by-click guide given 2026-09-27: her Gmail filter → forward to the finance
      inbox; add new senders to the finance-inbox `bank` filter if not BCA/Mandiri; add her full name in Family profile).
- [ ] Change the owner's app login password (the old one was shared in a chat; same login works for lyrsync).
- [ ] Automated encrypted backups (server-wide plan, see `~/.claude/CLAUDE.md`).

## Gotchas

- Forwarded bank emails arrive with CRLF line endings — normalise before parsing (done in `details.py`).
- iOS PWAs: first request after a long sleep may fail → front end retries GETs.
- Web Push to iPhone needs `Urgency: high`.
- PocketBase runs with `--hooksWatch=false` + `Restart=always`; don't touch `pb_hooks` needlessly.
