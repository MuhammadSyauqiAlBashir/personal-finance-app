# Financial Management (finance PWA) — Claude context

Household finance PWA for **Bashir** (owner, username `bashirsyauqi`) and his wife (**bells**). Live at
https://financial-management.bashir.my.id, installed as a Home Screen app on both iPhones. Bank emails → pending
transactions → confirm with a receipt → envelope wallets, reports, AI advisor, push notifications.

Read before deeper work: `README.md` (layout, operate, gotchas) and `docs/DESIGN.md` (every interview decision,
data model, flows; §11 changes after the first build). Server-wide facts (VPS, Caddy, PocketBase, security,
backups) are in `~/.claude/CLAUDE.md`.

Original conversations (everything the owner asked and decided, 2026-09-26 → 10-03, all apps; search them when a
detail is missing): `~/work/tx_user.txt` (owner's messages), `~/work/tx_asks.txt` (multiple-choice decisions),
`~/work/tx_assistant.txt` (Claude's longer answers); raw transcript
`~/.claude/projects/-home-bashir/b434ae8c-ff15-4ca3-aa6d-842e57f5a2aa.jsonl`.

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
| Backend | `finance.service` (FastAPI/uvicorn), user `finance`, 127.0.0.1:8100, sandboxed (score ~1.2), `Restart=always` (since 2026-10-03), ~20–80 MB RAM |
| Code on server | `/opt/finance` (+ `venv`), static web `/srv/finance`, state `/var/lib/finance` (VAPID key, `lock_sessions.json`) |
| Secrets | `/etc/finance/env` (`root:finance 0640`): `GEMINI_API_KEY`, `FIN_INGEST_SECRET`, `FIN_PB_SERVICE_USER`, `FIN_PB_SERVICE_PASSWORD`, `FIN_LOCK_IDLE_SECONDS=3600`. Backup `~/work/finance-env.bak-2026-10-01` (root 600, holds secrets; shred when no longer needed) |
| Data | PocketBase (shared), 21+ `fin_*` collections, rules `role = 'service'` only; service login `svc_finance`; settings in `fin_kv` |
| Caddy | `deploy/Caddyfile.finance` (static `/srv/finance` + `/api/*` → 8100; camera allowed on this site) |
| Gmail | finance inbox `personalfinancemanagementsera@gmail.com`; Apps Script `apps-script/Code.gs` ("Bank email forwarder", trigger `run` every 5 min) sends `bank`/`sample` emails to `/api/ingest/email` (HMAC) and saves confirmed receipts to that account's Drive (`Financial Management/Receipts/YYYY-MM/`). No Google credentials on the server |
| Deploy | `./deploy/deploy.sh` (`SKIP_PB_RESTART=1` to leave PocketBase running); deploy uses `install -C` for pb files |
| Tests | `~/work/fin-venv/bin/python -m pytest -q tests` (parsers + details on scrubbed real emails). JS: copy to `.mjs`, `node --check` (Node 18) |
| Logs | `sudo journalctl -u finance -n 100 --no-pager` (every push logged with Apple's status) |
| Backups | `pb-backup.timer` 01:00 → `deploy/pb-backup.py` (user `pocketbase`, group `finance`) zips the **whole shared PocketBase** (online SQLite backup of `data.db`, integrity-checked; + `storage/`, hooks, migrations; no `auxiliary.db`) to `/var/backups/pocketbase/pocketbase-backup-YYYY-MM-DD.zip` (7 days local). Apps Script `saveBackups_` pulls it via signed `/api/ingest/backups*` (SHA-256 checked) into Drive `Financial Management/Backups/` and trashes Drive backups > 28 days. Uploaded log: `/var/lib/finance/backups_uploaded.json`. Status: Settings → Backups; push to the owner at 09:05 if none reached Drive for 2 days. **Owner's choices (2026-10-03): whole database, plain .zip (no password), never delete app data.** Restore steps in the zip's README.txt (restore tested on scratch 2026-10-03). Run by hand: `sudo systemctl start pb-backup.service` |
| Scratch test env | `~/work/fin-scratch.sh` (:8101 → scratch PB `~/work/pb/fin1` on :8093) + `~/work/devproxy.py` :8102; browser checks `~/work/fin_check.py`, `shots*.py`, `race.py` (Playwright in `~/work/fin-venv`). Not running by default; stop by port (`ss -ltnp "sport = :8101"` → kill pid), never `pkill -f` (it once killed Claude's own shell) |
| Private files in `~/work` | `email-samples.txt` (0600, real bank emails, partly masked; delete when the owner agrees), `pb-before-finance-reset-2026-10-01.db` (root 600, full pre-reset copy; **keep until automated backups exist**), `pushtest.py` (test push to both phones) |
| One-off scripts on live DB | write `~/work/x.py`, `sudo install -m 644` to /tmp, run `sudo -u finance bash -c 'set -a; . /etc/finance/env; set +a; cd /opt/finance && PYTHONPATH=/opt/finance /opt/finance/venv/bin/python /tmp/x.py'`, delete it. **Writes need the owner's OK first** |

## How it works (short)

- Modules `backend/fin/`: `parsers.py` (BCA/Mandiri rules), `emails.py` (pipeline + Gemini fallback with amount
  cross-check), `details.py` (read-time "Bank details" card: from/to/amount/fee/refs, unwraps forwarded CRLF emails),
  `budget.py` (cycles, wallets, sweep, demo), `routes_*.py`, `receipts.py`, `reports.py`, `advisor.py`, `notify.py`
  (Web Push, `Urgency: high`), `scheduler.py` (00:05 close+sweep, 09:00 bills, 19:00 pending, 20:00 pace, 21:00
  daily), `security.py` (sessions + Face ID lock), `ai.py` (Gemini, wide model fallback).
- Envelope zero-based budget; cycle start day **28** (kv `cycle` `{"start_day": 28}`, set by the owner in the setup
  wizard 2026-10-01 09:47 WIB — his setting, don't change it). First period **1–27 Oct 2026**; first close + sweep +
  monthly report **28 Oct 00:05 WIB**, then 28th → 27th; `tracking_start` = 2026-10-01 (bank tx before it →
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

## Owner's original brief (2026-09-26) and extra facts

- Brief: bank emails to one inbox → server parses amounts (rules first, Gemini fallback) → a list to confirm with
  AI pre-fill → **both** spouses can confirm → a receipt photo must match (else the user picks which value is right)
  → budget wallets per category incl. "must spend" (rent…) → notifications, daily/monthly reports, forecasts of
  behaviour, an AI finance advisor; UI/UX as good as lyrsync, **especially the reports**; proof photos to Google Drive.
- Interview extras: income entered manually; Gemini must choose from the category master list or suggest a new
  one (a person approves); AI proposes the starting categories; family-background settings enrich the AI; payday
  was 25th at first, then 28; set to the 1st for the clean start (Sep incomes/plan moved to October, later reset);
  the owner chose 28 again in his real setup on 1 Oct.
- Gemini models: a Flash-Lite model for emails/receipts/screenshots/categories (highest free allowance), a stronger
  Flash model for advisor chat and monthly reviews; the key's project has **no billing**, so it can't cost money —
  never click "Set up billing/Upgrade" in AI Studio (going paid would need the owner's OK + a spending cap).
- Gmail: the personal inbox forwards only these senders: `bca@bca.co.id OR pasporbca@klikbca.com OR
  noreply.livin@bankmandiri.co.id` (domain matching would miss BCA debit-card mail from klikbca.com and include
  Halo BCA complaint mail). Mandiri also sends login/password alerts → skipped; `[TIDAK BERHASIL]` / "Tidak Berhasil"
  = failed, never counted. Labels `bank` → `processed`; `sample` = parser samples. Setup runbook in `docs/gmail-setup-runbook.md`.
- Demo data (removed by the owner): 141 made-up Aug/Sep transactions; the feature remains (Settings → Demo data).
- iPhone push not arriving with the app closed → check Settings → Notifications → Finance (Allow, Lock Screen/
  Banners, Delivery **Immediate** not Scheduled Summary), Focus/Do Not Disturb, Low Power Mode; then send a test
  (`~/work/pushtest.py`). Apple's status code is logged for every push.
- Researched 2026-09-27: paying/transferring **from** the app — not recommended. Bank APIs (SNAP) are business-only;
  e-wallet APIs are for merchants; licensed disbursement providers (Xendit, Midtrans, DOKU, Flip for Business) need
  merchant registration + a pre-funded balance and a stolen API key could drain it; never automate internet
  banking logins. The app keeps recording payments from bank emails instead.

## History (newest first)

- 2026-10-03 — Home: Remaining tile + shortcut row (Plan, Income, Move, Bills, Goals). Inbox: Select mode → confirm
  several at once (one wallet / reason / note; flagged, split or mismatched items excluded). Daily whole-database
  backup to the finance Drive (see Server facts → Backups). Owner: "database do not touch, EVER" — only backup files
  are ever deleted.
- 2026-10-03 — Inbox fixes (reproduced on the scratch stack first): one sheet per transaction (a double tap or a
  repeat route stacked two, so people filled the same one twice); unsent wallet lines / note / no-receipt reason kept
  as a per-device draft (`localStorage` `fin.drafts`) across sheet reloads (photo, Save details) and app restarts;
  confirming an already-confirmed transaction → 409 "Already confirmed by …" (was silently ignored); per-transaction
  lock on confirm/close (two phones at once could save wallet lines twice; live data checked: no damage); opening from
  a notification refreshes the Inbox after confirm; list refreshes in place (keeps scroll). Layout: sheets, + button,
  toasts and the lock overlay sit on the frame's bottom (`--frame-gap`), sheet top always below the status bar.
- 2026-10-03 — Docs checked against the live server (all deployed code matched the repo) and corrected: start
  day 28, exact Gmail senders in the runbook, service-only PocketBase rules, 1 Oct changes in DESIGN §11/§12.
  `finance.service` → `Restart=always`. First real transactions since 1 Oct: 28 confirmed (7 are e-wallet/Flazz
  top-ups, so no receipt by design), 6 receipts all in Drive, pushes accepted on both phones.
- 2026-10-01 — Lock after 1 hour; Face ID auto-start; lock sessions persisted; tab bar from `screen.height`;
  typing never locks (heartbeat); no zoom; richer Inbox bank details (`details.py`, 15 tests); Advisor input fix.
- 2026-10-01 — **Clean reset (owner's request):** plan, months, wallets/categories, goals, bill, merchant rules,
  reports, splits, activity log and kv `setup_done`/`profile`/`demo_periods` deleted → setup wizard ran again.
  Kept: bank emails, all 32 transactions (unlinked; the 1 confirmed one back to pending), push subs, passkeys,
  members, kv `cycle` (1), `holders`, `tracking_start`. Backup: `~/work/pb-before-finance-reset-2026-10-01.db` (root 600).
  The owner then finished the real setup (and set the cycle start day back to **28**).
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
`gemini-2.5-*` retired (404). Morning 429s can happen because BashGames' trivia filler uses the same quota; normal
bank emails are unaffected (rules, no Gemini).

## Open owner tasks (remind at session start, tick off when confirmed)

- [ ] Real go-live test: a small BCA/Mandiri payment on/after 1 Oct → push on both phones → attach receipt →
      confirm → check the receipt in Drive. Data says it works (2026-10-03: 6/6 receipts have a Drive id); owner
      still to confirm he sees them in Drive `Financial Management/Receipts/2026-10/`.
- [ ] Wife's bank-email forwarding (click-by-click guide given 2026-09-27: her Gmail filter → forward to the finance
      inbox; add new senders to the finance-inbox `bank` filter if not BCA/Mandiri; add her full name in Family profile). Unconfirmed; her banks were never named.
      `account_owners` is filled by hand in the Inbox, so it doesn't show whether forwarding works.
- [ ] Backups: server side live since 2026-10-03 (first zip made). Owner must paste the new `apps-script/Code.gs`
      into the Apps Script editor (Bank email forwarder) so zips reach Drive; then Settings → Backups shows "Last in Drive".

## Gotchas

- Forwarded bank emails arrive with CRLF line endings — normalise before parsing (done in `details.py`).
- iOS PWAs: first request after a long sleep may fail → front end retries GETs.
- Web Push to iPhone needs `Urgency: high`.
- PocketBase runs with `--hooksWatch=false` + `Restart=always`; don't touch `pb_hooks` needlessly.
