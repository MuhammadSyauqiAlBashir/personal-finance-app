"""Receiving bank emails from the Gmail Apps Script.

Every request is signed: X-Fin-Timestamp (unix seconds) and
X-Fin-Signature = hex(HMAC-SHA256(secret, timestamp + "." + raw body)).
Requests older than 5 minutes or with a bad signature are rejected, so a
captured request can't be replayed and nobody can post fake transactions.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import config
from .pb import PBError, pb, q
from .redact import redact

log = logging.getLogger("fin.ingest")
router = APIRouter()

MAX_BODY = 2_000_000
MAX_SKEW = 300


class Message(BaseModel):
    id: str = Field(min_length=5, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    thread_id: str = Field(default="", max_length=100)
    sender: str = Field(default="", max_length=300)
    subject: str = Field(default="", max_length=500)
    date: str = Field(default="", max_length=40)  # ISO 8601
    body: str = Field(default="", max_length=200_000)
    label: str = Field(pattern=r"^(bank|sample)$")


class Batch(BaseModel):
    messages: list[Message] = Field(max_length=50)


def verify_request(request: Request, body: bytes):
    """POST: sign "timestamp.body". GET: sign "timestamp.GET /path?query"."""
    payload = body if request.method == "POST" else \
        f"GET {request.url.path}{'?' + request.url.query if request.url.query else ''}".encode()
    verify(request.headers.get("x-fin-timestamp", ""), request.headers.get("x-fin-signature", ""), payload)


def verify(timestamp: str, signature: str, body: bytes):
    if not config.INGEST_SECRET:
        raise HTTPException(503, "Ingest is not configured.")
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        raise HTTPException(401, "Bad signature.")
    if abs(time.time() - ts) > MAX_SKEW:
        raise HTTPException(401, "Request expired.")
    expected = hmac.new(config.INGEST_SECRET.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, (signature or "").lower()):
        raise HTTPException(401, "Bad signature.")


def iso(date: str) -> str:
    try:
        return datetime.fromisoformat(date.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return ""


async def owner_names() -> list[str]:
    profile = await pb.kv_get("profile", {}) or {}
    return [n for n in (profile.get("names") or []) if isinstance(n, str)]


@router.post("/api/ingest/email")
async def ingest(request: Request, background: BackgroundTasks):
    body = await request.body()
    if len(body) > MAX_BODY:
        raise HTTPException(413, "Too large.")
    verify_request(request, body)
    try:
        batch = Batch.model_validate(json.loads(body))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Bad payload: {str(e)[:200]}")

    names = await owner_names()
    results = []
    new_ids = []
    for m in batch.messages:
        existing = await pb.first("fin_emails", f"gmail_id = {q(m.id)}")
        if existing:
            results.append({"id": m.id, "status": "duplicate"})
            continue
        try:
            rec = await pb.create("fin_emails", {
                "gmail_id": m.id,
                "is_sample": m.label == "sample",
                "sender": m.sender[:300],
                "subject": redact(m.subject, names)[:500],
                "received_at": iso(m.date) or None,
                "body": redact(m.body, names)[:60000],
                "status": "new",
            })
        except PBError as e:
            log.warning("store email %s failed: %s", m.id, e)
            results.append({"id": m.id, "status": "error"})
            continue
        new_ids.append(rec["id"])
        results.append({"id": m.id, "status": "stored"})

    if new_ids:
        from .emails import process_emails  # noqa: PLC0415 (avoid import cycle)
        background.add_task(process_emails, new_ids)
    return {"results": results}


# ---------------------------------------------------------------------------
# Receipts -> Google Drive, pulled by the same Apps Script (it runs as the
# finance Gmail, which owns the Drive). No Drive credentials on the server.
# ---------------------------------------------------------------------------

def receipt_id(value: str) -> str:
    import re as _re  # noqa: PLC0415
    if not _re.fullmatch(r"[a-z0-9]{15}", value or ""):
        raise HTTPException(404, "Not found.")
    return value


def receipt_filename(tx: dict, rec: dict) -> tuple[str, str]:
    import re as _re  # noqa: PLC0415
    from datetime import datetime as _dt  # noqa: PLC0415
    from .config import TZ  # noqa: PLC0415
    when = _dt.fromisoformat(tx["occurred_at"].replace(" ", "T").replace("Z", "+00:00")).astimezone(TZ)
    merchant = _re.sub(r"[^A-Za-z0-9]+", "-", tx.get("merchant") or "receipt").strip("-")[:40] or "receipt"
    ext = (rec.get("image") or "x.jpg").rsplit(".", 1)[-1].lower()
    return when.strftime("%Y-%m"), f"{when:%Y-%m-%d}_{merchant}_{int(tx['amount'])}_{rec['id']}.{ext}"


@router.get("/api/ingest/receipts")
async def receipts_queue(request: Request):
    verify_request(request, b"")
    recs = (await pb.list("fin_receipts", filter="drive_state = 'pending' && transaction.status = 'confirmed'",
                          sort="created", per_page=20, expand="transaction")).get("items", [])
    items = []
    for r in recs:
        tx = (r.get("expand") or {}).get("transaction")
        if not tx:
            continue
        month, name = receipt_filename(tx, r)
        items.append({"id": r["id"], "folder": month, "filename": name})
    return {"items": items}


@router.get("/api/ingest/receipts/{rid}/image")
async def receipts_image(rid: str, request: Request):
    verify_request(request, b"")
    rec = await pb.get("fin_receipts", receipt_id(rid))
    data, ctype = await pb.file_bytes("fin_receipts", rec["id"], rec["image"])
    return Response(data, media_type=ctype)


class DriveDone(BaseModel):
    drive_file_id: str = Field(min_length=5, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")


@router.post("/api/ingest/receipts/{rid}/done")
async def receipts_done(rid: str, request: Request):
    body = await request.body()
    verify_request(request, body)
    done = DriveDone.model_validate(json.loads(body))
    await pb.update("fin_receipts", receipt_id(rid), {"drive_file_id": done.drive_file_id, "drive_state": "uploaded"})
    return {"ok": True}
