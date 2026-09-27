"""Pick a category for a transaction.

1. Learned rules: a merchant confirmed into the same category twice is
   assigned directly.
2. Otherwise Gemini chooses from the household's category list, using the
   family profile as context. If nothing fits it proposes a new category;
   a person must approve that.
"""

from __future__ import annotations

import logging
import re

from . import ai
from .pb import PBError, pb, q

log = logging.getLogger("fin.categorize")


def merchant_key(merchant: str) -> str:
    s = re.sub(r"[^a-z0-9 ]", " ", (merchant or "").lower())
    s = re.sub(r"\b(pt|cv|tbk|toko|the)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()[:200]


async def learn(merchant: str, category_id: str):
    key = merchant_key(merchant)
    if not key:
        return
    rec = await pb.first("fin_merchant_rules", f"merchant_key = {q(key)}")
    try:
        if not rec:
            await pb.create("fin_merchant_rules", {"merchant_key": key, "category": category_id, "count": 1})
        elif rec["category"] == category_id:
            await pb.update("fin_merchant_rules", rec["id"], {"count": int(rec.get("count") or 0) + 1})
        else:  # changed their mind: start counting the new category
            await pb.update("fin_merchant_rules", rec["id"], {"category": category_id, "count": 1})
    except PBError as e:
        log.warning("learn failed: %s", e)


async def profile_context() -> str:
    p = await pb.kv_get("profile", {}) or {}
    parts = []
    for k, label in (("household", "Household"), ("city", "City"), ("work", "Work/income"),
                     ("dependants", "Dependants"), ("values", "Values/religion"), ("priorities", "Priorities"),
                     ("notes", "Notes")):
        if p.get(k):
            parts.append(f"{label}: {p[k]}")
    return "\n".join(parts)


SCHEMA = {
    "type": "object",
    "properties": {
        "category_id": {"type": "string", "nullable": True, "description": "id from the list, or null"},
        "confidence": {"type": "number", "description": "0..1"},
        "suggest_new": {
            "type": "object", "nullable": True,
            "properties": {"name": {"type": "string"}, "group": {"type": "string",
                                                               "enum": ["must", "needs", "wants", "savings"]}},
            "required": ["name", "group"],
        },
        "reason": {"type": "string", "description": "one short sentence"},
    },
    "required": ["reason", "category_id", "confidence"],
    "propertyOrdering": ["reason", "category_id", "confidence", "suggest_new"],
}

SYSTEM = """You categorise household transactions for an Indonesian family's envelope budget.
Choose exactly one category from the provided list by its id. Only if none reasonably fits, set
category_id to null and propose a short new category name (English, 1-3 words) with its group:
must = fixed obligations (rent, utilities, installments, insurance, school fees),
needs = essential variable spending (groceries, transport, health),
wants = discretionary (eating out, entertainment, shopping, hobbies),
savings = saving/investing. Be conservative: prefer an existing category when it is close.
Indonesian merchant hints: Indomaret/Alfamart = minimarket, PLN = electricity, PDAM = water,
Telkomsel/XL/Indosat = phone credit, BPJS = health insurance, GoFood/GrabFood = food delivery,
GoRide/GrabBike = transport, Tokopedia/Shopee = online shopping (check the item if known)."""


async def suggest(merchant: str, description: str, amount: int, kind: str = "expense",
                  extra: str = "") -> dict:
    """Returns {category, confidence, suggest_new, reason, source}."""
    key = merchant_key(merchant)
    if key:
        rule = await pb.first("fin_merchant_rules", f"merchant_key = {q(key)}")
        if rule and int(rule.get("count") or 0) >= 2:
            return {"category": rule["category"], "confidence": 0.95, "suggest_new": None,
                    "reason": "You filed this merchant here before.", "source": "learned"}
    cats = await pb.all("fin_categories", filter="archived = false", sort="sort,name")
    if not cats:
        return {"category": None, "confidence": 0, "suggest_new": None, "reason": "No categories yet.",
                "source": "none"}
    listing = "\n".join(f"- id={c['id']} | {c['name']} | group={c['group']}"
                        + (f" | covers: {c['hints']}" if c.get("hints") else "") for c in cats)
    prompt = (f"Categories:\n{listing}\n\nFamily context:\n{await profile_context() or '(none)'}\n\n"
              f"Transaction: {kind}, Rp{amount:,}".replace(",", ".")
              + f"\nMerchant/payee: {merchant or '-'}\nDetails: {description or '-'}\n{extra}")
    try:
        out = await ai.generate([prompt], system=SYSTEM, schema=SCHEMA)
    except ai.AIUnavailable as e:
        log.warning("categorize unavailable: %s", e)
        return {"category": None, "confidence": 0, "suggest_new": None, "reason": "AI unavailable.",
                "source": "none"}
    ids = {c["id"] for c in cats}
    cat = out.get("category_id") if out.get("category_id") in ids else None
    new = out.get("suggest_new") if not cat else None
    return {"category": cat, "confidence": float(out.get("confidence") or 0), "suggest_new": new,
            "reason": (out.get("reason") or "")[:300], "source": "ai"}
