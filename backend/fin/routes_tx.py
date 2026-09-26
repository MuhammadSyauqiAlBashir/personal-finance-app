"""API: transactions, receipts, confirm/ignore, e-wallet top-up purchases."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import ai, budget, categorize, config, drive, notify, receipts
from .pb import PBError, pb, q
from .security import User, member

log = logging.getLogger("fin.tx")
router = APIRouter(prefix="/api")

PB_ID = re.compile(r"^[a-z0-9]{15}$")
MAX_IMAGE = 15 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


def rid(value: str) -> str:
    if not PB_ID.match(value or ""):
        raise HTTPException(404, "Not found.")
    return value


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_date(occurred_at: str):
    return datetime.fromisoformat(occurred_at.replace(" ", "T").replace("Z", "+00:00")).astimezone(config.TZ).date()


async def enrich(txs: list[dict]) -> list[dict]:
    """Attach splits, receipts and (for top-ups) purchases to transactions."""
    if not txs:
        return []
    ids = [t["id"] for t in txs]
    filt = " || ".join(f"transaction = {q(i)}" for i in ids)
    splits = await pb.all("fin_splits", filter=filt) if ids else []
    recs = await pb.all("fin_receipts", filter=filt, fields="id,transaction,image,match,drive_state,created")
    topups = [t["id"] for t in txs if t["kind"] == "topup"]
    children = await pb.all("fin_transactions", filter=" || ".join(f"parent = {q(i)}" for i in topups),
                            sort="occurred_at") if topups else []
    out = []
    for t in txs:
        item = dict(t)
        item["splits"] = [s for s in splits if s["transaction"] == t["id"]]
        item["receipts"] = [{"id": r["id"], "match": r.get("match"), "drive_state": r.get("drive_state")}
                            for r in recs if r["transaction"] == t["id"]]
        if t["kind"] == "topup":
            kids = [c for c in children if c["parent"] == t["id"] and c["kind"] == "expense"
                    and c["status"] != "ignored"]
            accounted = sum(int(c["amount"]) for c in kids)
            item["purchases"] = kids
            item["accounted"] = accounted
            item["remaining"] = int(t["amount"]) - accounted
        out.append(item)
    return out


@router.get("/transactions")
async def list_transactions(status: str = "pending", period: str = "", search: str = "", page: int = 1,
                            user: User = Depends(member)):
    filters = []
    if status != "all":
        if status not in ("pending", "confirmed", "ignored", "failed"):
            raise HTTPException(400, "Unknown status.")
        filters.append(f"status = {q(status)}")
    if period:
        filters.append(f"period = {q(rid(period))}")
    if search.strip():
        s = search.strip()[:80]
        filters.append(f"(merchant ~ {q(s)} || description ~ {q(s)} || note ~ {q(s)})")
    if status == "pending":
        # Top-up purchases show inside their top-up, not as separate items.
        filters = [f for f in filters if not f.startswith("status =")] + [budget.PENDING_FILTER]
    data = await pb.list("fin_transactions", filter=" && ".join(filters), sort="-occurred_at",
                         page=max(1, page), per_page=50, skip_total=False)
    return {"items": await enrich(data.get("items", [])), "page": data.get("page", 1),
            "total_pages": data.get("totalPages", 1), "total": data.get("totalItems", 0)}


@router.get("/transactions/{tid}")
async def get_transaction(tid: str, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    item = (await enrich([tx]))[0]
    if tx.get("email"):
        try:
            em = await pb.get("fin_emails", tx["email"])
            item["email_info"] = {"subject": em.get("subject"), "method": em.get("method"),
                                  "sender": em.get("sender"), "body": em.get("body", "")[:6000]}
        except PBError:
            pass
    return item


class TxIn(BaseModel):
    amount: int = Field(gt=0, le=10_000_000_000)
    occurred_at: datetime
    merchant: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=1000)
    account: str = Field(default="Cash", max_length=40)
    note: str = Field(default="", max_length=1000)
    kind: str = Field(default="expense", pattern=r"^(expense|topup)$")
    wallet: str = Field(default="", max_length=40)
    parent: str = ""
    category: str = ""  # optional: the wallet chosen when adding (pre-selected for confirming)


@router.post("/transactions")
async def create_transaction(body: TxIn, user: User = Depends(member)):
    when = body.occurred_at if body.occurred_at.tzinfo else body.occurred_at.replace(tzinfo=config.TZ)
    period = await budget.period_for(when.astimezone(config.TZ).date())
    parent = None
    if body.parent:
        parent = await pb.get("fin_transactions", rid(body.parent))
        if parent["kind"] != "topup":
            raise HTTPException(400, "Purchases can only be added under a top-up.")
    rec = {
        "status": "pending", "kind": body.kind, "amount": body.amount, "occurred_at": when.isoformat(),
        "period": period["id"], "merchant": body.merchant, "description": body.description,
        "account": parent["wallet"] if parent else body.account, "note": body.note, "source": "manual",
        "receipt_state": "missing", "flags": {}, "created_by": user.username, "wallet": body.wallet,
        "parent": parent["id"] if parent else None,
    }
    if body.kind == "expense" and body.category:
        rec["ai"] = {"category": rid(body.category), "confidence": 1, "suggest_new": None,
                     "reason": "Chosen when adding.", "source": "you"}
    elif body.kind == "expense":
        rec["ai"] = await categorize.suggest(body.merchant, body.description, body.amount)
    return await pb.create("fin_transactions", rec)


class TxEdit(BaseModel):
    amount: int | None = Field(default=None, gt=0, le=10_000_000_000)
    occurred_at: datetime | None = None
    merchant: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    account: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=1000)
    kind: str | None = Field(default=None, pattern=r"^(expense|transfer|topup)$")
    wallet: str | None = Field(default=None, max_length=40)


@router.patch("/transactions/{tid}")
async def edit_transaction(tid: str, body: TxEdit, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    if tx["status"] == "confirmed":
        raise HTTPException(400, "Undo the confirmation first to edit.")
    data = body.model_dump(exclude_none=True)
    if "occurred_at" in data:
        when = body.occurred_at if body.occurred_at.tzinfo else body.occurred_at.replace(tzinfo=config.TZ)
        data["occurred_at"] = when.isoformat()
        data["period"] = (await budget.period_for(when.astimezone(config.TZ).date()))["id"]
    return await pb.update("fin_transactions", tid, data)


@router.post("/transactions/{tid}/recategorize")
async def recategorize(tid: str, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    s = await categorize.suggest(tx.get("merchant", ""), tx.get("description", ""), int(tx["amount"]))
    return await pb.update("fin_transactions", tid, {"ai": s})


# ---------------------------------------------------------------------------
# Receipts
# ---------------------------------------------------------------------------

async def read_image(file: UploadFile) -> tuple[bytes, str]:
    mime = (file.content_type or "").lower()
    if mime not in IMAGE_TYPES:
        raise HTTPException(400, "Receipts must be JPEG, PNG or WebP photos.")
    data = await file.read(MAX_IMAGE + 1)
    if len(data) > MAX_IMAGE:
        raise HTTPException(413, "Photo is too large (max 15 MB).")
    sig = data[:12]
    ok = (sig.startswith(b"\xff\xd8\xff") or sig.startswith(b"\x89PNG") or (sig[:4] == b"RIFF" and sig[8:12] == b"WEBP"))
    if not ok:
        raise HTTPException(400, "That file isn't a valid image.")
    return data, mime


async def store_receipt(tx: dict, data: bytes, mime: str, user: User) -> tuple[dict, dict]:
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime]
    try:
        extracted = await receipts.extract(data, mime)
    except ai.AIUnavailable as e:
        log.warning("receipt read failed: %s", e)
        extracted = {"is_receipt": True, "error": "The AI couldn't read this photo right now."}
    match = receipts.check(extracted, tx) if "error" not in extracted else {"overall": "unknown"}
    rec = await pb.create("fin_receipts", {"transaction": tx["id"], "extracted": extracted, "match": match,
                                           "drive_state": "pending", "uploaded_by": user.username},
                          files={"image": (f"receipt.{ext}", data, mime)})
    update: dict = {"receipt_state": "attached", "waive_reason": ""}
    splits = extracted.get("splits") or []
    # The receipt's items give a better category suggestion (and a split) than the bank text,
    # as long as the receipt is for this amount.
    if splits and match.get("amount") == "ok":
        update["ai"] = {**(tx.get("ai") or {}), "splits": splits, "source": "receipt", "confidence": 0.85,
                        "category": splits[0]["category_id"] if len(splits) == 1 else (tx.get("ai") or {}).get("category"),
                        "reason": "From the receipt items.", "suggest_new": extracted.get("suggest_new")}
    await pb.update("fin_transactions", tx["id"], update)
    return rec, extracted


@router.post("/transactions/{tid}/receipt")
async def upload_receipt(tid: str, file: UploadFile = File(...), user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    data, mime = await read_image(file)
    rec, extracted = await store_receipt(tx, data, mime, user)
    return {"receipt": {"id": rec["id"], "match": rec["match"]}, "extracted": extracted}


async def create_from_receipt(data: bytes, mime: str, user: User, topup: dict | None = None) -> dict:
    """A pending expense built from a receipt/screenshot photo (optionally under a top-up)."""
    try:
        extracted = await receipts.extract(data, mime)
    except ai.AIUnavailable:
        extracted = {}
    amount = int(extracted.get("total") or 0)
    when = datetime.now(config.TZ)
    if extracted.get("date"):
        try:
            when = datetime.fromisoformat(f"{extracted['date'][:10]}T{(extracted.get('time') or '12:00')[:5]}:00"
                                          ).replace(tzinfo=config.TZ)
        except ValueError:
            pass
    period = await budget.period_for(when.date())
    splits = extracted.get("splits") or []
    flags = {} if amount else {"amount_check": "The AI couldn't read the total. Please enter it."}
    if topup:
        remaining = (await enrich([topup]))[0]["remaining"]
        if amount and amount > remaining:
            flags["exceeds_topup"] = (f"This purchase is more than the top-up's remaining balance "
                                      f"(Rp{remaining:,}). Was part of it paid another way?").replace(",", ".")
    wallet = topup.get("wallet") if topup else ""
    child = await pb.create("fin_transactions", {
        "status": "pending", "kind": "expense", "amount": max(amount, 1), "occurred_at": when.isoformat(),
        "period": period["id"], "merchant": (extracted.get("merchant") or "")[:200],
        "description": f"Paid with {wallet or 'e-wallet'}" if topup else (extracted.get("payment_method") or "")[:200],
        "account": (wallet or "E-wallet") if topup else (extracted.get("payment_method") or "")[:40],
        "source": "screenshot", "receipt_state": "missing", "flags": flags, "created_by": user.username,
        "parent": topup["id"] if topup else None,
        "ai": {"category": splits[0]["category_id"] if len(splits) == 1 else None,
               "confidence": 0.8 if splits else 0, "suggest_new": extracted.get("suggest_new"),
               "reason": "From the receipt.", "source": "receipt", "splits": splits},
    })
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime]
    await pb.create("fin_receipts", {"transaction": child["id"], "extracted": extracted,
                                     "match": {"overall": "match" if amount else "unknown"}, "drive_state": "pending",
                                     "uploaded_by": user.username},
                    files={"image": (f"receipt.{ext}", data, mime)})
    child = await pb.update("fin_transactions", child["id"], {"receipt_state": "attached"})
    return {"transaction": (await enrich([child]))[0], "extracted": extracted}


@router.post("/transactions/from-receipt")
async def from_receipt(file: UploadFile = File(...), user: User = Depends(member)):
    """A payment with no bank email (cash, some QRIS/e-wallet): start from its photo."""
    data, mime = await read_image(file)
    return await create_from_receipt(data, mime, user)


@router.post("/transactions/{tid}/purchase")
async def add_purchase(tid: str, file: UploadFile = File(...), user: User = Depends(member)):
    """E-wallet: create a purchase under a top-up from its receipt photo."""
    topup = await pb.get("fin_transactions", rid(tid))
    if topup["kind"] != "topup":
        raise HTTPException(400, "Not a top-up.")
    data, mime = await read_image(file)
    return await create_from_receipt(data, mime, user, topup)


@router.get("/receipts/{rcid}/image")
async def receipt_image(rcid: str, thumb: bool = False, user: User = Depends(member)):
    rec = await pb.get("fin_receipts", rid(rcid))
    data, ctype = await pb.file_bytes("fin_receipts", rec["id"], rec["image"], thumb="480x0" if thumb else "")
    return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/receipts/{rcid}")
async def delete_receipt(rcid: str, user: User = Depends(member)):
    rec = await pb.get("fin_receipts", rid(rcid))
    tx = await pb.get("fin_transactions", rec["transaction"])
    if tx["status"] == "confirmed":
        raise HTTPException(400, "Undo the confirmation first.")
    await pb.delete("fin_receipts", rcid)
    if not (await pb.list("fin_receipts", filter=f"transaction = {q(tx['id'])}", per_page=1))["items"]:
        await pb.update("fin_transactions", tx["id"], {"receipt_state": "missing"})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Confirm / ignore
# ---------------------------------------------------------------------------

class SplitIn(BaseModel):
    category: str
    amount: int = Field(gt=0, le=10_000_000_000)
    note: str = Field(default="", max_length=300)


class ConfirmIn(BaseModel):
    splits: list[SplitIn] = Field(default_factory=list, max_length=30)
    waive_reason: str = Field(default="", max_length=200)
    note: str | None = Field(default=None, max_length=1000)


async def check_bills(tx: dict, splits: list[SplitIn]):
    """Mark a must-spend bill paid when a confirmed payment matches it:
    same category, and the merchant contains the bill's hint or the amount is within Rp1.000."""
    cats = {s.category for s in splits}
    merchant = (tx.get("merchant") or "").lower()
    for b in await pb.all("fin_bills", filter="active = true"):
        if b["category"] not in cats:
            continue
        hint = (b.get("match_hint") or b["name"]).lower()
        if hint not in merchant and abs(int(b.get("amount") or 0) - int(tx["amount"])) > 1000:
            continue
        if not await pb.first("fin_bill_payments", f"bill = {q(b['id'])} && period = {q(tx['period'])}"):
            await pb.create("fin_bill_payments", {"bill": b["id"], "period": tx["period"], "transaction": tx["id"]})


@router.post("/transactions/{tid}/confirm")
async def confirm(tid: str, body: ConfirmIn, background: BackgroundTasks, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    if tx["status"] == "confirmed":
        return tx
    if tx["status"] not in ("pending",):
        raise HTTPException(400, "Only pending transactions can be confirmed.")
    update = {"status": "confirmed", "confirmed_by": user.username, "confirmed_at": now_iso()}
    if body.note is not None:
        update["note"] = body.note.strip()

    if tx["kind"] == "expense":
        if not body.splits:
            raise HTTPException(400, "Choose a category.")
        total = sum(s.amount for s in body.splits)
        if total != int(tx["amount"]):
            raise HTTPException(400, f"The split adds up to Rp{total:,} but the transaction is "
                                     f"Rp{int(tx['amount']):,}.".replace(",", "."))
        cats = {c["id"]: c for c in await budget.categories()}
        for s in body.splits:
            if s.category not in cats:
                raise HTTPException(400, "One of the categories doesn't exist (or is archived).")
        if tx["receipt_state"] == "missing":
            if not body.waive_reason.strip():
                raise HTTPException(400, "Attach a receipt, or tick 'no receipt' and give a reason.")
            update.update(receipt_state="waived", waive_reason=body.waive_reason.strip())
        for old in await pb.all("fin_splits", filter=f"transaction = {q(tid)}"):
            await pb.delete("fin_splits", old["id"])
        for s in body.splits:
            await pb.create("fin_splits", {"transaction": tid, "category": s.category, "amount": s.amount,
                                           "note": s.note})
        if len(body.splits) == 1 and tx.get("merchant"):
            await categorize.learn(tx["merchant"], body.splits[0].category)
        await check_bills(tx, body.splits)
    elif tx["kind"] == "topup":
        kids = (await enrich([tx]))[0]
        if kids["remaining"] > 0:
            raise HTTPException(400, "This top-up still has money to account for. Add purchases, "
                                     "or close it with the rest.")
        pending = [c for c in kids["purchases"] if c["status"] == "pending"]
        if pending:
            raise HTTPException(400, "Confirm the purchases under this top-up first.")
    # transfer: nothing to split; it doesn't touch budgets.

    tx = await pb.update("fin_transactions", tid, update)
    if tx["kind"] == "expense":
        background.add_task(drive.upload_for_transaction, tid)
        background.add_task(notify.after_confirm, tid)
    return tx


class CloseTopupIn(BaseModel):
    category: str
    note: str = Field(default="", max_length=300)


@router.post("/transactions/{tid}/close")
async def close_topup(tid: str, body: CloseTopupIn, background: BackgroundTasks, user: User = Depends(member)):
    """Account for a top-up's remaining balance in one category (e.g. small untracked purchases)."""
    topup = await pb.get("fin_transactions", rid(tid))
    if topup["kind"] != "topup":
        raise HTTPException(400, "Not a top-up.")
    item = (await enrich([topup]))[0]
    if item["remaining"] > 0:
        rest = await pb.create("fin_transactions", {
            "status": "confirmed", "kind": "expense", "amount": item["remaining"], "occurred_at": now_iso(),
            "period": (await budget.period_for())["id"], "merchant": f"{topup.get('wallet') or 'E-wallet'} (rest)",
            "description": "Rest of the top-up, no individual receipts", "account": topup.get("wallet") or "",
            "source": "manual", "receipt_state": "waived", "waive_reason": body.note or "Closed the top-up",
            "parent": tid, "flags": {}, "created_by": user.username, "confirmed_by": user.username,
            "confirmed_at": now_iso(),
        })
        await pb.create("fin_splits", {"transaction": rest["id"], "category": rid(body.category),
                                       "amount": item["remaining"], "note": ""})
    return await confirm(tid, ConfirmIn(), background, user)


@router.post("/transactions/{tid}/unconfirm")
async def unconfirm(tid: str, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    if tx["status"] != "confirmed":
        raise HTTPException(400, "Not confirmed.")
    return await pb.update("fin_transactions", tid, {"status": "pending", "confirmed_by": "", "confirmed_at": None})


@router.post("/transactions/{tid}/ignore")
async def ignore(tid: str, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    if tx["status"] == "confirmed":
        raise HTTPException(400, "Undo the confirmation first.")
    return await pb.update("fin_transactions", tid, {"status": "ignored"})


@router.post("/transactions/{tid}/restore")
async def restore(tid: str, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    if tx["status"] != "ignored":
        raise HTTPException(400, "Not ignored.")
    return await pb.update("fin_transactions", tid, {"status": "pending"})


@router.delete("/transactions/{tid}")
async def delete_transaction(tid: str, user: User = Depends(member)):
    tx = await pb.get("fin_transactions", rid(tid))
    if tx["source"] == "email":
        raise HTTPException(400, "Bank transactions can't be deleted; ignore it instead.")
    if tx["status"] == "confirmed":
        raise HTTPException(400, "Undo the confirmation first.")
    await pb.delete("fin_transactions", tid)
    return {"ok": True}
