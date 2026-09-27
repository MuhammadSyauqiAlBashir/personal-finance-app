# Financial Management — design

Household finance PWA for Bashir and his wife. Address: **https://financial-management.bashir.my.id**.
Decisions below come from the owner interview on 2026-09-26.

## 1. Decisions

| Topic | Decision |
|---|---|
| Users | Bashir + wife, **fully shared** household: both see everything, either can confirm. Accounts reuse the shared PocketBase `users` (register → admin approves); access to this app is a separate membership list. |
| Method | **Envelope, zero-based.** Each category is a wallet. At payday all income is assigned to wallets. The AI advisor proposes amounts; the owners decide. |
| Budget month | **Configurable start day** (default 25 → month runs 25th → 24th). Settings → Budget cycle. Days 29–31 fall back to the month's last day in short months. Changing it keeps past months as they were, moves the current month's end to the day before the new start day (with a preview to confirm), and later months follow the new day. |
| Month end | Leftovers in every wallet **sweep to savings** (emergency fund first, then goals). Wallets start fresh. Overspending is shown as a negative that must be covered by moving money from another wallet. |
| Income | Entered **manually**. |
| Accounts | BCA, Mandiri (plus Cash). |
| Receipts | **Required, with exceptions** (tick "no receipt" + reason). Receipts can be **split** across categories. Proof photos stored in **Google Drive** (account given later) and in the app. |
| Categories | Master list managed in the app (add, rename, icon/colour, group, archive, merge). The AI proposes the starting list. Gemini must choose from the list; if nothing fits it suggests a new category, which a person must approve. |
| Category groups | **Must spend** (rent, electricity, installments…), **Needs**, **Wants**, **Savings**. Groups drive the 50/30/20 view. |
| Goals | **Emergency fund** + **custom goals** (target amount, optional date). |
| AI | Gemini **free tier**. Before sending, bank text is redacted (account/card numbers, names). Receipt photos are sent as-is. BCA/Mandiri emails are parsed by fixed rules first; Gemini only for unknown formats. |
| Advisor | Chat + automatic monthly review + short AI commentary inside reports + category suggestions. A **family profile** in settings (household, city, jobs, dependants, values, priorities) enriches every prompt. It sees category totals and trends, not raw emails. |
| Notifications | New transaction to confirm · 3+ unconfirmed reminder · wallet 80%/100% and pace alerts · daily report · monthly report · bill reminders (3 days before + overdue). |
| Security | Normal login + **Face ID (passkey) lock** enforced by the server: after idle time the API refuses requests until a passkey check passes. |
| Language | English. |
| History | Start fresh. |
| E-wallet top-ups | A top-up (GoPay, OVO, ShopeePay, DANA…) is **not** spending. It opens an e-wallet balance ("Rp200.000 to account for"). Each real purchase (GoFood order etc.) is added under it with its own receipt and category and counts on its own date. Fees become a small "Bank & admin fees" item. The balance closes at Rp0; unaccounted money counts toward the pending reminder. |
| Wife's banks | Her bank emails are forwarded to the same finance inbox (her own runbook). The owner of each account is recognised from the name in the email. Transfers between any household accounts (own or spouse's) are internal and don't count. |

## 2. Architecture

```
Bank (BCA/Mandiri) ──email──▶ dedicated Gmail ──Apps Script (every 1–5 min, HMAC-signed)──┐
                                                                                        ▼
iPhone PWA ──HTTPS──▶ Caddy ──/api──▶ finance backend (FastAPI, 127.0.0.1:8100, user `finance`)
                         └── static files /srv/finance                 │
                                                                       ├─▶ PocketBase (fin_* collections)
                                                                       ├─▶ Gemini API (extraction, advisor)
                                                                       ├─▶ receipts → Google Drive via the Apps Script
                                                                       └─▶ Web Push (VAPID) to both phones
```

- Same patterns as lyrsync: static PWA with no external scripts and a strict CSP (camera allowed on this
  site only), httpOnly session cookie, request header check, sandboxed systemd unit.
- Charts are hand-drawn SVG (no chart library): donut, bars, burn-down line with forecast band,
  calendar heatmap.
- One in-process scheduler handles reminders, reports and the payday rollover (Asia/Jakarta time).
- Background jobs act through a dedicated PocketBase **service user** (`role = service`), not a superuser,
  so the backend can't touch lyrsync or other apps' data.
- Secrets (Gemini key, Apps Script HMAC secret, service login) live in `/etc/finance/env`, root-owned, readable
  only by the `finance` user (0640 root:finance). The VAPID key is generated into `/var/lib/finance`.
- Receipts reach Google Drive through the same Apps Script (it runs as the finance inbox, which owns the Drive):
  it lists confirmed receipts, saves them, and reports the Drive file id back. No Google credentials on the server.

## 3. Data model (PocketBase, prefix `fin_`)

| Collection | Key fields |
|---|---|
| `fin_members` | user → household access (Bashir, wife) |
| `fin_profile` | family background text + structured fields (single record) |
| `fin_categories` | name, group (must/needs/wants/savings), icon, colour, default_amount, archived, sort, ai_hints |
| `fin_periods` | start (25th), end (24th), status open/closed, income_total, swept_to_savings |
| `fin_incomes` | period, amount, source, date, note, created_by |
| `fin_allocations` | period, category, amount (the wallet fill) |
| `fin_moves` | period, from_category, to_category, amount, reason (cover overspending) |
| `fin_transactions` | status (pending/confirmed/ignored/duplicate), kind (expense/income/internal transfer), amount, date, merchant, description, account (BCA/Mandiri/Cash), source (email/manual/screenshot), email_ref, ai_category, ai_confidence, receipt_state (missing/attached/waived), waive_reason, confirmed_by, confirmed_at |
| `fin_splits` | transaction, category, amount, note (always ≥1 row once confirmed) |
| `fin_receipts` | transaction, image (local file), drive_file_id, extracted JSON, match result |
| `fin_bills` | must-spend template: name, category, amount, due_day, active |
| `fin_bill_status` | period, bill, paid transaction |
| `fin_goals` | kind (emergency/custom), name, target, target_date, saved |
| `fin_goal_moves` | goal, amount, period, source (sweep/manual) |
| `fin_emails` | gmail message id (unique), received_at, sender, parse method, status, transaction, redacted text |
| `fin_push_subs` | user, endpoint, keys, created |
| `fin_passkeys` | user, credential id, public key, sign count |
| `fin_reports` | period/day, kind (daily/monthly/review), numbers JSON, AI commentary |
| `fin_chat` | user, role, content, created (advisor chat) |

Rules: every `fin_` collection is readable/writable only by members (`@collection.fin_members.user ?=
@request.auth.id`) or the service user.

## 4. Transaction flow

1. **Arrives**: a bank email (Apps Script), a shared screenshot, or manual quick-add.
2. **Parsed**: BCA/Mandiri rules → amount, date/time, merchant/beneficiary, account. Unknown format →
   redacted text to Gemini with a JSON schema. Own-account transfers (BCA ↔ Mandiri, to each other) are
   marked internal and don't touch budgets.
3. **Deduped**: Gmail id; plus same amount + account within 10 minutes → flagged "possible duplicate".
4. **Pre-filled**: Gemini picks a category from the master list (or proposes a new one) using the merchant,
   past confirmations for the same merchant (learned), and the family profile.
   → push "Rp125.000 at Indomaret — tap to confirm".
5. **Receipt**: take/choose a photo → Gemini extracts merchant, date, total, line items.
   - Match = amount equal (±Rp100 rounding), date within ±1 day, merchant similar → "Matches" badge.
   - Mismatch → side-by-side "email says / receipt says"; the person picks per field.
   - Items suggest a split across categories; editable.
   - Or tick "no receipt" + reason.
6. **Confirm** (either person) → splits deduct from wallets; receipt uploaded to Drive
   (`Financial Management/Receipts/YYYY-MM/2026-09-26_Indomaret_125000.jpg`); a failed upload retries in
   the background.
7. Pending items: badge in the app + a reminder push when 3 or more are waiting.

## 5. Budget cycle

- **Setup (once)**: family profile → AI proposes categories and groups → owners edit → add must-spend
  bills and goals.
- **Each cycle start (payday, default 25th)**:
  1. The closing period's wallet leftovers sweep to savings (emergency fund until its target, then goals).
  2. A new period opens. Owners enter income.
  3. The advisor proposes wallet amounts (must-spend first, then savings, then needs/wants; uses the last
     months' actual spending, goals and the family profile). Owners adjust until "Rp0 left to assign".
  4. The monthly report + AI review is generated for the month just closed.
- During the month: move money between wallets to cover overspending ("cover from…").

## 6. Reports

- **Home**: safe-to-spend today, days to payday, wallet cards (spent / left / pace), pending count.
- **Daily** (push at 21:00): today's spending by category, vs daily pace, notable items.
- **Monthly** (on payday): income vs spending, per-wallet budget vs actual, needs/wants/savings split vs
  50/30/20, top merchants, spending calendar heatmap, receipts coverage, AI review.
- **Trends & forecast**: 6-month category trends; month-end projection (run-rate + unpaid bills) with a
  range; wallets predicted to run out and when; goal ETAs at the current savings rate; behaviour patterns
  (weekday/weekend, payday spike).
- Any past month can be opened as a report.

## 7. Notifications (Web Push; iPhone needs the Home Screen app, iOS 16.4+)

| Trigger | When |
|---|---|
| New transaction to confirm | immediately |
| 3+ unconfirmed | when reached, then at most daily at 19:00 |
| Wallet at 80% / 100% | on confirm |
| Spending ahead of pace | daily check |
| Daily report | 21:00 |
| Monthly report + review | payday morning |
| Bill due in 3 days / overdue | 09:00 |

## 8. Build milestones

1. **Core**: schema + rules, membership, categories master + AI starter list, periods/income/allocation
   with AI suggestion, manual transactions + confirm + splits, wallets home screen.
2. **Receipts**: camera/upload, Gemini extraction, match check, split, Drive upload.
3. **Email ingest**: Apps Script + HMAC endpoint, BCA/Mandiri parsers, Gemini fallback, dedupe,
   screenshot import.
4. **Notifications + scheduler**: push subscriptions, all triggers, payday rollover + sweep.
5. **Reports + advisor**: daily/monthly/trends/forecast, AI commentary, chat, monthly review, family profile.
6. **Face ID lock, backups, polish.**

## 9. Gmail setup (done 2026-09-26)

| | |
|---|---|
| Finance inbox | `personalfinancemanagementsera@gmail.com` (forwarding all mail: off) |
| Source | `bashirsyauqi@gmail.com`: filter forwards bank senders only (inbox kept); forward-all off |
| Senders | `bca@bca.co.id OR pasporbca@klikbca.com OR noreply.livin@bankmandiri.co.id` |
| Finance inbox filter | senders → label `bank`; label `processed` also exists |

What each sender sends:

- `bca@bca.co.id`: "Internet Transaction Journal" (myBCA), "Cash Withdrawal Successful".
- `PasporBCA@klikbca.com`: "Informasi Transaksi Online - Debit BCA [BERHASIL / TIDAK BERHASIL]" (debit card).
- `noreply.livin@bankmandiri.co.id`: Transfer / BI Fast / Pembayaran / Top-up Berhasil or Tidak Berhasil,
  **and** non-transaction alerts ("Akses Terbaru ke Livin' by Mandiri", "Password Berhasil Diubah").

Ingest must:

- skip non-transactions (login/password alerts);
- record failed transactions (`[TIDAK BERHASIL]`, "Tidak Berhasil") as failed and never count them;
- read label `bank`, then move the thread to `processed`;
- on the first real email, check it arrived labelled `bank`. Filter-forwarded mail should keep the bank's
  `From`; if not, switch the finance-inbox filter to subject or `deliveredto:` matching.

Old emails were not forwarded (filters only act on new mail). Parser samples can be forwarded by hand from
the personal inbox; they will arrive unlabelled, which is fine for building rules.

## 10. Needed from the owner

- ~~The dedicated Gmail address for bank emails~~ (done, see §9).
- 2–3 real example emails of each type from BCA and Mandiri (numbers can be masked) for the parsers.
- A Gemini API key from Google AI Studio — put on the server by the owner, never pasted in chat.
- ~~The Google account for Drive~~: `personalfinancemanagementsera@gmail.com` (one-time sign-in at the end).
- ~~Wife's account~~: `bells` (already approved); add her as a member.

## 11. Changes after the first build (2026-09-26 → 27)

| Change | Why |
|---|---|
| Budget cycle start day is configurable (now **1**); changing it keeps past months and re-dates the current one | Owner wanted a clean start on 1 Oct |
| `tracking_start` = 2026-10-01: earlier bank transactions are stored as `ignored` (flag `before_tracking_start`); bill, pace, pending and daily notifications wait for it | Clean Inbox from day one |
| E-wallet top-ups are balances: purchases (with receipts) are added under them; fees become their own item | Owner decision (spending is the purchase, not the top-up) |
| Receipts reach Drive through the same Apps Script instead of Drive OAuth | No Google credentials on the server; no Cloud project for the owner |
| Demo months (kv `demo_periods`): labelled everywhere, ignored by the advisor, notifications, learning and the sweep; removable in Settings | Preview reports before real data (demo was later removed by the owner) |
| Optional note on confirm, shown in the Inbox and a "Notes" section of the monthly report | Owner request |
| Optional wallet when adding by hand (pre-selected at confirm) | Owner expected to choose it when adding |
| Pushes sent with `Urgency: high`; every push logged | iOS held normal-urgency pushes until the app opened |
| Front end retries reads after a long sleep | iOS stale-connection "no internet" on first open |
| Gemini: money as strings, all fields required + `propertyOrdering`, no temperature override, wide model fallback | Free-tier models looped/skipped fields; 503 spikes |

## 12. Status (2026-09-27)

Live; installed on both iPhones; setup done; push verified on both phones; October income + plan in place. Next:
real test payment on/after 1 Oct, wife's email forwarding, automated encrypted backups.
