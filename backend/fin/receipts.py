"""Reading receipt photos with Gemini and checking them against a transaction."""

from __future__ import annotations

import logging
import re
from datetime import date, datetime

from . import ai
from .categorize import profile_context
from .pb import pb

log = logging.getLogger("fin.receipts")

AMOUNT = {"type": "string", "description": "whole rupiah, digits only, no decimals or separators, e.g. 312450"}

SCHEMA = {
    "type": "object",
    "properties": {
        "is_receipt": {"type": "boolean", "description": "false if the image is not a receipt/proof of payment"},
        "merchant": {"type": "string", "description": "shop/restaurant name, empty if not visible"},
        "date": {"type": "string", "description": "YYYY-MM-DD, empty if not visible"},
        "time": {"type": "string", "description": "HH:MM, empty if not visible"},
        "items": {"type": "array", "description": "purchased lines as printed (empty list if none)",
                  "items": {"type": "object", "properties": {"name": {"type": "string"}, "amount": AMOUNT},
                            "required": ["name", "amount"], "propertyOrdering": ["name", "amount"]}},
        "total": {**AMOUNT, "description": "final amount paid; whole rupiah digits only, e.g. 312450"},
        "payment_method": {"type": "string", "description": "e.g. QRIS, BCA debit, GoPay, cash; empty if unknown"},
        "splits": {"type": "array", "description": "the total divided over categories; must add up to total",
                   "items": {"type": "object", "properties": {
                       "category_id": {"type": "string"}, "amount": AMOUNT,
                       "items": {"type": "string", "description": "which items, short"}},
                       "required": ["category_id", "amount", "items"],
                       "propertyOrdering": ["category_id", "items", "amount"]}},
        "suggest_new": {"type": "object", "nullable": True, "properties": {
            "name": {"type": "string"}, "group": {"type": "string", "enum": ["must", "needs", "wants", "savings"]}},
            "required": ["name", "group"]},
    },
    "required": ["is_receipt", "merchant", "date", "time", "items", "total", "payment_method", "splits"],
    "propertyOrdering": ["is_receipt", "merchant", "date", "time", "items", "total", "payment_method", "splits",
                         "suggest_new"],
}

SYSTEM = """You read Indonesian receipts and payment screenshots (supermarket receipts, restaurant bills,
GoFood/GrabFood/Shopee/Tokopedia order screens, QRIS payment confirmations). Amounts are rupiah:
'125.000' and '125,000' both mean 125000. total = the final amount paid (after discounts, tax, service,
delivery fees). Then divide the total across the household's categories (by category id from the list):
group items by category; put tax/service/delivery fees proportionally or with the main group. Splits must
add up exactly to total. Use one split if everything belongs to one category. If no category fits,
use the closest and propose suggest_new. Never invent values you can't read; leave them empty."""


async def extract(image: bytes, mime: str) -> dict:
    cats = await pb.all("fin_categories", filter="archived = false", sort="sort,name")
    listing = "\n".join(f"- id={c['id']} | {c['name']} | group={c['group']}"
                        + (f" | covers: {c['hints']}" if c.get("hints") else "") for c in cats)
    prompt = f"Categories:\n{listing or '(none yet)'}\n\nFamily context:\n{await profile_context() or '(none)'}"
    out = await ai.generate([prompt, ai.image_part(image, mime)], system=SYSTEM, schema=SCHEMA)
    ids = {c["id"] for c in cats}
    total = ai.money(out.get("total"))
    out["total"] = total
    for item in out.get("items") or []:
        item["amount"] = ai.money(item.get("amount"))
    for sp in out.get("splits") or []:
        sp["amount"] = ai.money(sp.get("amount"))
    splits = [s for s in (out.get("splits") or []) if s.get("category_id") in ids and s["amount"] > 0]
    if splits and total and sum(int(s["amount"]) for s in splits) != total:
        # Fix rounding so the split adds up: adjust the largest part.
        biggest = max(splits, key=lambda s: s["amount"])
        biggest["amount"] += total - sum(int(s["amount"]) for s in splits)
    out["splits"] = splits
    return out


def _norm(s: str) -> set[str]:
    words = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()
    stop = {"pt", "cv", "tbk", "toko", "the", "indonesia", "id", "store", "official", "jakarta"}
    return {w for w in words if len(w) > 2 and w not in stop}


def merchant_similar(a: str, b: str) -> bool | None:
    wa, wb = _norm(a), _norm(b)
    if not wa or not wb:
        return None
    if wa & wb:
        return True
    ja, jb = "".join(sorted(wa)), "".join(sorted(wb))
    return any(x in y for x in wa for y in wb if len(x) >= 4) or ja in jb or jb in ja


def check(extracted: dict, tx: dict) -> dict:
    """Compare a receipt with the transaction. Each field: ok | mismatch | unknown."""
    result = {}
    total = int(extracted.get("total") or 0)
    if not total:
        result["amount"] = "unknown"
    else:
        result["amount"] = "ok" if abs(total - int(tx["amount"])) <= 100 else "mismatch"
    try:
        rd = date.fromisoformat((extracted.get("date") or "")[:10])
        td = datetime.fromisoformat(tx["occurred_at"].replace(" ", "T").replace("Z", "+00:00")).date()
        result["date"] = "ok" if abs((rd - td).days) <= 1 else "mismatch"
    except ValueError:
        result["date"] = "unknown"
    sim = merchant_similar(extracted.get("merchant", ""), tx.get("merchant", ""))
    # Bank emails often name the payment processor, not the shop: don't block on it.
    result["merchant"] = "unknown" if sim is None else ("ok" if sim else "different")
    hard = [result["amount"], result["date"]]
    result["overall"] = ("mismatch" if "mismatch" in hard else
                         "match" if all(v == "ok" for v in hard) else "partial")
    if not extracted.get("is_receipt", True):
        result["overall"] = "not_a_receipt"
    return result
