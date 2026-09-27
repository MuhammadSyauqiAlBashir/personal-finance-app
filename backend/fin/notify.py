"""Web Push notifications to household members' phones.

The VAPID signing key is generated on first use and kept in the state dir
(/var/lib/finance), readable only by the service. iPhones receive pushes only
for the Home Screen app (iOS 16.4+).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import datetime

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from . import budget, config
from .pb import PBError, pb, q

log = logging.getLogger("fin.notify")

_vapid: Vapid | None = None


def rp(n: int) -> str:
    return "Rp" + f"{int(n):,}".replace(",", ".")


def vapid() -> Vapid:
    global _vapid
    if _vapid is None:
        path = os.path.join(config.STATE_DIR, "vapid_private.pem")
        if os.path.exists(path):
            _vapid = Vapid.from_file(path)
        else:
            v = Vapid()
            v.generate_keys()
            os.makedirs(config.STATE_DIR, exist_ok=True)
            v.save_key(path)
            os.chmod(path, 0o600)
            _vapid = v
    return _vapid


def public_key() -> str:
    raw = vapid().public_key.public_bytes(serialization.Encoding.X962,
                                          serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _send_one(sub: dict, payload: str, urgency: str) -> int:
    try:
        # Urgency "high" makes Apple/Google deliver right away even when the phone is idle
        # (without it iOS may hold the notification until the app is opened).
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=payload, vapid_private_key=vapid(), vapid_claims={"sub": config.VAPID_SUBJECT},
            ttl=12 * 3600, timeout=15, headers={"Urgency": urgency},
        )
        return 201
    except WebPushException as e:
        return e.response.status_code if e.response is not None else 0
    except Exception as e:  # network errors etc.; never break the caller
        log.warning("push failed: %s", e)
        return 0


async def send(title: str, body: str, url: str = "/", tag: str = "", users: list[str] | None = None,
               urgency: str = "high"):
    """Push to every subscribed device of the given users (default: all members)."""
    filt = " || ".join(f"user = {q(u)}" for u in users) if users else ""
    try:
        subs = await pb.all("fin_push_subs", filter=filt)
    except PBError as e:
        log.warning("push subs unavailable: %s", e)
        return
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag or url})
    for sub in subs:
        status = await asyncio.to_thread(_send_one, sub, payload, urgency)
        log.info("push %r -> %s…: %s", title[:40], sub["endpoint"][8:30], status)
        if status in (404, 410):  # subscription expired or app removed
            await pb.delete("fin_push_subs", sub["id"])
        elif status not in (200, 201):
            log.warning("push to %s… answered %s", sub["endpoint"][:40], status)


def today_key() -> str:
    return datetime.now(config.TZ).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Triggers
# ---------------------------------------------------------------------------

async def new_transaction(tx: dict):
    if tx["kind"] == "topup":
        await send(f"{tx.get('wallet') or 'E-wallet'} top-up {rp(tx['amount'])}",
                   "Add the purchases from it with their receipts.", f"/#tx/{tx['id']}", tag=f"tx-{tx['id']}")
    elif tx["kind"] == "transfer":
        return  # own-account moves need no attention right away
    else:
        where = f" at {tx['merchant']}" if tx.get("merchant") else ""
        await send(f"{rp(tx['amount'])}{where}", "Tap to confirm and add the receipt.", f"/#tx/{tx['id']}",
                   tag=f"tx-{tx['id']}")
    await pending_reminder(immediate=True)


async def pending_reminder(immediate: bool = False):
    """3+ transactions waiting: remind once when reached, then at most daily."""
    data = await pb.list("fin_transactions", filter=budget.PENDING_FILTER, per_page=1, skip_total=False)
    n = data.get("totalItems", 0)
    if n < 3:
        return
    key = f"pending3:{today_key()}" if not immediate else f"pending3-reached:{today_key()}"
    if await pb.event_once(key):
        await send(f"{n} transactions to confirm", "Confirm them so your wallets stay accurate.", "/#pending",
                   tag="pending")


async def after_confirm(tx_id: str):
    """Wallet alerts at 80% and 100% of the month's budget."""
    tx = await pb.get("fin_transactions", tx_id)
    splits = await pb.all("fin_splits", filter=f"transaction = {q(tx_id)}")
    if not splits or not tx.get("period"):
        return
    period = await pb.get("fin_periods", tx["period"])
    s = await budget.summary(period)
    wallets = {w["category"]["id"]: w for w in s["wallets"]}
    for cid in {sp["category"] for sp in splits}:
        w = wallets.get(cid)
        if not w or not w["budget"]:
            continue
        name = f"{w['category'].get('icon') or ''} {w['category']['name']}".strip()
        if w["pct"] >= 100 and await pb.event_once(f"w100:{period['id']}:{cid}"):
            over = -w["left"]
            await send(f"{name} wallet is empty",
                       f"Over by {rp(over)}. Move money from another wallet to cover it." if over > 0
                       else "Nothing left in it for this month.", "/#wallets", tag=f"wallet-{cid}")
        elif w["pct"] >= 80 and await pb.event_once(f"w80:{period['id']}:{cid}"):
            await send(f"{name} wallet at {int(w['pct'])}%",
                       f"{rp(w['left'])} left for {s['days_left']} days.", "/#wallets", tag=f"wallet-{cid}")
