"""Turning stored bank emails into pending transactions (parsers come next)."""

from __future__ import annotations

import logging

log = logging.getLogger("fin.emails")


async def process_emails(ids: list[str]):
    # Samples wait for the parsers; real emails are processed once parsing exists.
    log.info("received %d email(s)", len(ids))
