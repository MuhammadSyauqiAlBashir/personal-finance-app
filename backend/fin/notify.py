"""Push notifications (Web Push). Filled in with the notifications milestone."""

from __future__ import annotations

import logging

log = logging.getLogger("fin.notify")


async def new_transaction(tx: dict):
    log.info("new pending transaction %s", tx["id"])


async def after_confirm(tx_id: str):
    log.info("confirmed %s", tx_id)
