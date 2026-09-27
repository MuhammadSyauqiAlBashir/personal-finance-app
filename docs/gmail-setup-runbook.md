# Runbook: Gmail setup for bank-email forwarding

**For:** Claude with the Chrome extension (Claude in Chrome), run on the owner's PC.
**Goal:** only BCA and Mandiri emails from the owner's personal Gmail get forwarded to a dedicated
"finance inbox" Gmail, where they are labelled `bank`. A server script will later read that label.

## Accounts

| Role | Address |
|---|---|
| **PERSONAL** (receives bank emails today) | `bashirsyauqi@gmail.com` |
| **FINANCE INBOX** (new, dedicated) | *Ask the owner for this address before starting.* Write it here: `________________` |

## Rules for the agent

- **Never type passwords, 2FA codes or recovery info.** If a login or verification is needed, stop and
  ask the owner to do it, then continue.
- **Before every change, confirm which account is active:** click the profile picture at the top right
  of Gmail and read the email address. Do this whenever switching tabs.
- **Only change the settings listed here.** Don't delete emails, don't change other settings, don't
  send emails.
- Gmail's interface may be in **Indonesian**. Both languages are given below as `English / Indonesian`.
- Use the **desktop Gmail web** (https://mail.google.com), not the mobile site.
- If something doesn't match this runbook, **stop and describe what you see** instead of guessing.

## Part 1 — Find the real bank sender addresses (PERSONAL)

1. Open Gmail as **PERSONAL**.
2. Search `BCA`, open a recent email that is clearly a transaction notice from BCA. Click the sender
   name/avatar and note the exact sender address (e.g. `...@bca.co.id`).
3. Repeat with `Mandiri` (e.g. `...@bankmandiri.co.id`).
4. Build the filter text from the **domains** found, joined with ` OR `. Expected result:
   `bca.co.id OR bankmandiri.co.id`. If the real domains differ, use the real ones and tell the owner.
   Call this text **SENDERS** below.

## Part 2 — Turn off "forward everything" (PERSONAL)

The owner accidentally enabled forwarding of **all** incoming mail. It must be off; a filter does the
forwarding instead.

1. As **PERSONAL**: ⚙️ Settings → **See all settings / Lihat semua setelan** →
   tab **Forwarding and POP/IMAP / Penerusan dan POP/IMAP**.
2. Section **Forwarding / Penerusan**:
   - Open the address dropdown. Check whether **FINANCE INBOX** is in the list.
     - If it is **not**: click **Add a forwarding address / Tambahkan alamat penerusan**, enter
       **FINANCE INBOX**, then **Next / Berikutnya → Proceed / Lanjutkan → OK**. Google sends a
       confirmation email to FINANCE INBOX — go to Part 3 step 1, click the link, then come back here.
   - Select **Disable forwarding / Nonaktifkan**.
     ⚠️ Do NOT select "Forward a copy of incoming mail to… / Teruskan salinan email yang masuk ke…".
3. Leave POP and IMAP settings unchanged.
4. Click **Save Changes / Simpan Perubahan** at the bottom.
5. Reopen the tab and verify **Disable forwarding / Nonaktifkan** is still selected.

## Part 3 — Prepare FINANCE INBOX

1. (Only if Part 2 sent a confirmation email.) Open Gmail as **FINANCE INBOX**, open the email from
   Google "Gmail Forwarding Confirmation", click the confirmation link.
2. As **FINANCE INBOX**: ⚙️ → See all settings → **Forwarding and POP/IMAP**. Make sure forwarding is
   **Disable forwarding / Nonaktifkan** (FINANCE INBOX must not forward anything — it would create a
   loop). Save if changed.
3. Create two labels: left sidebar → **Labels / Label** → **+** → name `bank` → Create. Repeat for
   `processed`. Skip any that already exist.

## Part 4 — Filter: forward bank emails (PERSONAL)

1. As **PERSONAL**, click the **sliders icon** (Show search options) at the right of the search bar.
2. **From / Dari:** type **SENDERS** only (e.g. `bca.co.id OR bankmandiri.co.id`).
   ⚠️ Do not type `from:` or brackets in this box.
3. Leave the other boxes empty. Click **Create filter / Buat filter**.
4. Tick **Forward it to / Teruskan ke:** and choose **FINANCE INBOX**.
5. Do **not** tick "Skip the Inbox / Lewati Kotak Masuk" (the owner still wants to see bank emails).
6. Click **Create filter / Buat filter**.
7. If an older filter for the same senders already forwards elsewhere, report it to the owner; don't
   delete it.

## Part 5 — Filter: label bank emails (FINANCE INBOX)

1. As **FINANCE INBOX**, sliders icon → **From / Dari:** **SENDERS** → **Create filter / Buat filter**.
2. Tick **Apply the label / Terapkan label:** → choose `bank`.
3. Tick **Also apply filter to matching conversations / Terapkan juga filter ke percakapan yang cocok**
   if shown.
4. **Create filter / Buat filter**.

## Part 6 — Verify

1. As **PERSONAL**: ⚙️ → See all settings → **Filters and Blocked Addresses / Filter dan Alamat yang
   Diblokir**. There must be one filter: *from SENDERS → Forward to FINANCE INBOX*.
2. As **FINANCE INBOX**: same page. There must be one filter: *from SENDERS → Apply label "bank"*.
3. Both accounts: Forwarding and POP/IMAP → **Disable forwarding / Nonaktifkan** selected.
4. Manual test: as **PERSONAL**, open one real BCA email, click **Forward / Teruskan**, send it to
   FINANCE INBOX. (**Ask the owner before sending.**) It should arrive in FINANCE INBOX. Note: a
   manually forwarded email comes *from* PERSONAL, so it will **not** get the `bank` label — that's
   expected. The real test is the next genuine bank email, which should arrive labelled `bank`.

## Part 7 — Report back to the owner

Give the owner this summary to paste to Claude on the server:

```
Gmail setup done.
FINANCE INBOX: <address>
SENDERS used: <text>
Personal forwarding (all mail): disabled
Personal filter: SENDERS -> forward to FINANCE INBOX (inbox kept)
Finance inbox filter: SENDERS -> label "bank"
Labels in finance inbox: bank, processed
Anything unusual: <notes, or "none">
```
