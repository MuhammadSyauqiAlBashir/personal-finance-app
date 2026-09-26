"""Receipts reach Google Drive through the Gmail Apps Script (see ingest.py):
it runs as the finance account, lists confirmed receipts with drive_state
'pending', saves each into Drive and reports the file id back."""

from __future__ import annotations


async def upload_for_transaction(tx_id: str):
    # Nothing to push: receipts of confirmed transactions are picked up by the
    # Apps Script on its next run (every 5 minutes).
    return None
