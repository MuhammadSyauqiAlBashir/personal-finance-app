"""Turning stored bank emails into pending transactions.

Rules first (parsers.py). Unknown layouts go to Gemini (text already
redacted); its amount must appear in the email or the transaction is flagged
for checking. Samples are parsed and kept for testing, never recorded.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from . import ai, budget, categorize, notify
from .parsers import Parsed, Skip, all_amounts, parse_email, same_person
from .pb import PBError, pb, q

log = logging.getLogger("fin.emails")

AI_SCHEMA = {
    "type": "object",
    "properties": {
        "is_transaction": {"type": "boolean", "description": "false for login alerts, promos, OTP, statements"},
        "bank": {"type": "string"},
        "status": {"type": "string", "enum": ["success", "failed"]},
        "kind": {"type": "string", "enum": ["expense", "transfer", "topup", "income"]},
        "amount": {**ai.MONEY, "description": "total rupiah that left the account incl. fees; whole rupiah digits only"},
        "fee": {**ai.MONEY, "description": "fee in whole rupiah digits, \"0\" if none"},
        "occurred_at": {"type": "string", "description": "ISO 8601 with +07:00 (WIB) unless stated otherwise"},
        "merchant": {"type": "string", "description": "merchant, biller or recipient"},
        "description": {"type": "string", "description": "transaction type, e.g. QRIS Payment, Debit card"},
        "account": {"type": "string", "description": "bank + last digits of the source account/card"},
        "holder": {"type": "string", "description": "account holder name from the greeting"},
        "wallet": {"type": "string", "description": "e-wallet name if this tops up an e-wallet"},
    },
    "required": ["is_transaction", "bank", "status", "kind", "description", "merchant", "account", "holder", "wallet", "occurred_at", "fee", "amount"],
    "propertyOrdering": ["is_transaction", "bank", "status", "kind", "description", "merchant", "account", "holder", "wallet", "occurred_at", "fee", "amount"],
}

AI_SYSTEM = """You extract one bank transaction from an Indonesian bank notification email (BCA, Mandiri,
or other). Numbers like account/card numbers are masked. Amounts are rupiah: '1.250.000,00' and
'1,250,000.00' both mean 1250000. Return is_transaction=false for anything that is not a completed or
failed money movement (login alerts, password changes, OTPs, promotions, statements).
kind: 'topup' when money goes into an e-wallet (GoPay, OVO, ShopeePay, DANA, LinkAja);
'transfer' when the recipient is the same person as the account holder; otherwise 'expense'
('income' only for money received). Never invent values: leave a field empty if it isn't in the email."""


async def known_holders() -> list[str]:
    return (await pb.kv_get("holders", [])) or []


async def remember_holder(name: str):
    if not name or name.upper() in ("[OWNER]",):
        return
    holders = await known_holders()
    if not any(same_person(name, h) for h in holders):
        holders.append(name)
        await pb.kv_set("holders", holders[-20:])


async def ai_parse(sender: str, subject: str, body: str) -> Parsed | Skip | None:
    prompt = f"From: {sender}\nSubject: {subject}\n\n{body[:12000]}"
    out = await ai.generate([prompt], system=AI_SYSTEM, schema=AI_SCHEMA)
    if not out.get("is_transaction"):
        return Skip("AI: not a transaction")
    amount = ai.money(out.get("amount"))
    if amount <= 0 or not out.get("occurred_at"):
        return None
    try:
        when = datetime.fromisoformat(out["occurred_at"].replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=budget.config.TZ)
    except ValueError:
        return None
    return Parsed(
        bank=(out.get("bank") or "")[:40], status=out.get("status") or "success",
        kind=out.get("kind") if out.get("kind") in ("expense", "transfer", "topup") else "expense",
        amount=amount, occurred_at=when.isoformat(), merchant=(out.get("merchant") or "")[:200],
        description=(out.get("description") or "")[:200], account=(out.get("account") or "")[:40],
        holder=(out.get("holder") or "")[:100], wallet=(out.get("wallet") or "")[:40], fee=ai.money(out.get("fee")),
    )


def pb_time(dt: datetime) -> str:
    """PocketBase stores dates as UTC 'YYYY-MM-DD HH:MM:SS'."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def possible_duplicate(p: Parsed) -> str | None:
    """Same amount within 10 minutes (e.g. a Tokopedia order paid via GoPay sends two emails)."""
    when = datetime.fromisoformat(p.occurred_at)
    rec = await pb.first("fin_transactions",
                         f"amount = {p.amount} && occurred_at >= {q(pb_time(when - timedelta(minutes=10)))}"
                         f" && occurred_at <= {q(pb_time(when + timedelta(minutes=10)))} && status != 'ignored'")
    return rec["id"] if rec else None


async def create_from_parsed(p: Parsed, email_id: str, flags: dict) -> dict:
    when = datetime.fromisoformat(p.occurred_at)
    period = await budget.period_for(when.astimezone(budget.config.TZ).date())
    holders = await known_holders()
    kind = p.kind
    if kind == "expense" and p.merchant and any(same_person(p.merchant, h) for h in holders) \
            and "transfer" in (p.description or "").lower():
        kind = "transfer"  # to the spouse or another household account
    merchant = p.merchant
    if kind == "transfer":
        detail = (p.fields or {}).get("party_detail") or ""
        merchant = f"Own account ({detail})" if detail else "Own account"
    if dup := await possible_duplicate(p):
        flags["possible_duplicate_of"] = dup
    # Before the household's tracking start date (clean start), record but ignore.
    start = await pb.kv_get("tracking_start", "")
    before_start = bool(start) and when.astimezone(budget.config.TZ).date().isoformat() < start
    if before_start:
        flags["before_tracking_start"] = start
    base = {
        "status": "failed" if p.status == "failed" else "ignored" if before_start else "pending",
        "amount": p.amount - (p.fee if kind in ("topup", "transfer") else 0),
        "occurred_at": when.isoformat(), "period": period["id"], "merchant": merchant[:200],
        "description": p.description, "account": p.account, "source": "email", "email": email_id,
        "receipt_state": "waived" if kind == "transfer" else "missing",
        "waive_reason": "Transfer between own accounts" if kind == "transfer" else "",
        "flags": flags, "holder": p.holder, "wallet": p.wallet, "kind": kind,
    }
    if kind == "expense" and base["status"] == "pending":
        base["ai"] = await categorize.suggest(p.merchant, p.description, p.amount)
    tx = await pb.create("fin_transactions", base)
    # Fees on top-ups and own-account transfers are real spending: separate item.
    if p.fee and kind in ("topup", "transfer") and base["status"] == "pending":
        fee_cat = await pb.first("fin_categories", "name ~ 'fee' && archived = false")
        await pb.create("fin_transactions", {
            "status": "pending", "kind": "expense", "amount": p.fee, "occurred_at": when.isoformat(),
            "period": period["id"], "merchant": f"{p.bank} fee", "description": f"Fee: {p.description}",
            "account": p.account, "source": "email", "email": email_id, "receipt_state": "waived",
            "waive_reason": "Bank fee (the email is the proof)", "holder": p.holder,
            "flags": {"fee_of": tx["id"]}, "ai": {"category": fee_cat["id"] if fee_cat else None, "confidence": 0.9,
                                "suggest_new": None if fee_cat else {"name": "Bank & admin fees", "group": "needs"},
                                "reason": "Bank/admin fee.", "source": "rule"},
        })
    return tx


async def process_one(email_id: str):
    rec = await pb.get("fin_emails", email_id)
    if rec["status"] not in ("new", "error"):
        return
    sender, subject, result = parse_email(rec.get("sender", ""), rec.get("subject", ""), rec.get("body", ""))
    method = "rules" if result is not None else "none"
    flags: dict = {}
    if result is None:
        try:
            result = await ai_parse(sender, subject, rec.get("body", ""))
            method = "ai"
        except ai.AIUnavailable as e:
            await pb.update("fin_emails", email_id, {"status": "error", "error": f"AI unavailable: {e}"[:1000]})
            return
        if isinstance(result, Parsed) and result.amount not in all_amounts(rec.get("body", "")):
            flags["amount_check"] = "The AI's amount wasn't found in the email. Please check it."
    if isinstance(result, Skip):
        await pb.update("fin_emails", email_id, {"status": "skipped", "method": method,
                                                 "parsed": {"skip": result.reason}})
        return
    if result is None:
        await pb.update("fin_emails", email_id, {"status": "failed", "method": method,
                                                 "error": "Couldn't read a transaction from this email."})
        return
    await remember_holder(result.holder)
    update = {"status": "parsed", "method": method, "parsed": result.to_dict()}
    if rec.get("is_sample"):
        await pb.update("fin_emails", email_id, update)
        return
    tx = await create_from_parsed(result, email_id, flags)
    await pb.update("fin_emails", email_id, update)
    if tx["status"] == "pending":
        await notify.new_transaction(tx)


async def process_emails(ids: list[str]):
    for email_id in ids:
        try:
            await process_one(email_id)
        except (PBError, ai.AIUnavailable, ValueError, KeyError) as e:
            log.exception("processing email %s failed", email_id)
            try:
                await pb.update("fin_emails", email_id, {"status": "error", "error": str(e)[:1000]})
            except PBError:
                pass


async def process_pending():
    """Retry emails that are new or errored (startup and periodic)."""
    recs = await pb.all("fin_emails", filter="status = 'new' || status = 'error'", sort="received_at", fields="id")
    await process_emails([r["id"] for r in recs])
