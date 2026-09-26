"""API: reports, advisor chat, push subscriptions, passkeys (Face ID lock), email log."""

from __future__ import annotations

import json
import re
import time
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from webauthn import (generate_authentication_options, generate_registration_options, options_to_json,
                      verify_authentication_response, verify_registration_response)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                      ResidentKeyRequirement, UserVerificationRequirement)

from . import advisor, ai, budget, config, notify, reports
from .pb import pb, q
from .security import User, _locks, admin, member, signed_in

router = APIRouter(prefix="/api")
PB_ID = re.compile(r"^[a-z0-9]{15}$")


def rid(value: str) -> str:
    if not PB_ID.match(value or ""):
        raise HTTPException(404, "Not found.")
    return value


def ai_error(e: Exception):
    raise HTTPException(503, f"The AI is busy right now ({str(e)[:100]}). Try again in a minute.")


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@router.get("/reports/daily")
async def report_daily(day: str = "", note: bool = False, user: User = Depends(member)):
    d = date.fromisoformat(day) if day else budget.today()
    data = await reports.daily(d)
    if note and (data["total"] or data["pending"]):
        data["note"] = await reports.ai_note("daily", d.isoformat(), data)
    return data


@router.get("/reports/monthly")
async def report_monthly(period: str = "", user: User = Depends(member)):
    p = await pb.get("fin_periods", rid(period)) if period else await budget.period_for()
    data = await reports.monthly(p)
    rec = await pb.first("fin_reports", f"kind = 'monthly' && key = {q(p['start'])}")
    data["review"] = rec.get("ai_text") if rec else ""
    return data


@router.post("/reports/monthly/review")
async def report_review(period: str = "", refresh: bool = False, user: User = Depends(member)):
    p = await pb.get("fin_periods", rid(period)) if period else await budget.period_for()
    try:
        return {"review": await reports.monthly_review(p, refresh=refresh)}
    except ai.AIUnavailable as e:
        ai_error(e)


@router.get("/reports/trends")
async def report_trends(months: int = 6, user: User = Depends(member)):
    return await reports.trends(max(2, min(24, months)))


@router.get("/reports/forecast")
async def report_forecast(note: bool = False, user: User = Depends(member)):
    data = await reports.forecast()
    if note and data["enough_data"]:
        data["note"] = await reports.ai_note("forecast", budget.today().isoformat(), {
            k: data[k] for k in ("projected_total", "projected_range", "income", "spent", "days_left", "wallets", "goals")})
    return data


# ---------------------------------------------------------------------------
# Advisor chat (per person)
# ---------------------------------------------------------------------------

class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


@router.get("/advisor/chat")
async def chat_history(user: User = Depends(member)):
    msgs = (await pb.list("fin_chat", filter=f"user = {q(user.id)}", sort="-created", per_page=60)).get("items", [])
    return {"messages": [{"role": m["role"], "content": m["content"], "created": m["created"]} for m in reversed(msgs)]}


@router.post("/advisor/chat")
async def chat_send(body: ChatIn, user: User = Depends(member)):
    history = (await chat_history(user))["messages"]
    try:
        answer = await advisor.chat(history, body.message.strip())
    except ai.AIUnavailable as e:
        ai_error(e)
    await pb.create("fin_chat", {"user": user.id, "role": "user", "content": body.message.strip()})
    await pb.create("fin_chat", {"user": user.id, "role": "assistant", "content": answer[:20000]})
    return {"answer": answer}


@router.delete("/advisor/chat")
async def chat_clear(user: User = Depends(member)):
    for m in await pb.all("fin_chat", filter=f"user = {q(user.id)}", fields="id"):
        await pb.delete("fin_chat", m["id"])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Push subscriptions
# ---------------------------------------------------------------------------

@router.get("/push/key")
async def push_key(user: User = Depends(member)):
    return {"key": notify.public_key()}


class SubIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000, pattern=r"^https://")
    p256dh: str = Field(min_length=10, max_length=200)
    auth: str = Field(min_length=5, max_length=100)
    ua: str = Field(default="", max_length=300)


@router.post("/push/subscribe")
async def push_subscribe(body: SubIn, user: User = Depends(member)):
    existing = await pb.first("fin_push_subs", f"endpoint = {q(body.endpoint)}")
    data = {**body.model_dump(), "user": user.id}
    if existing:
        await pb.update("fin_push_subs", existing["id"], data)
    else:
        await pb.create("fin_push_subs", data)
    return {"ok": True}


class UnsubIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000)


@router.post("/push/unsubscribe")
async def push_unsubscribe(body: UnsubIn, user: User = Depends(member)):
    existing = await pb.first("fin_push_subs", f"endpoint = {q(body.endpoint)} && user = {q(user.id)}")
    if existing:
        await pb.delete("fin_push_subs", existing["id"])
    return {"ok": True}


@router.post("/push/test")
async def push_test(user: User = Depends(member)):
    await notify.send("Notifications work 🎉", "You'll get alerts about transactions, wallets and bills here.",
                      "/", tag="test", users=[user.id])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Passkeys (Face ID lock)
# ---------------------------------------------------------------------------

ORIGIN = config.PUBLIC_URL


async def user_passkeys(user_id: str) -> list[dict]:
    return await pb.all("fin_passkeys", filter=f"user = {q(user_id)}")


@router.get("/passkeys")
async def list_passkeys(user: User = Depends(member)):
    return {"passkeys": [{"id": p["id"], "name": p.get("name"), "created": p["created"]}
                         for p in await user_passkeys(user.id)]}


@router.post("/passkey/register/options")
async def passkey_register_options(user: User = Depends(member)):
    existing = await user_passkeys(user.id)
    opts = generate_registration_options(
        rp_id=config.RP_ID, rp_name="Financial Management", user_name=user.username,
        user_id=user.id.encode(), user_display_name=user.username,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED, user_verification=UserVerificationRequirement.REQUIRED),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p["cred_id"])) for p in existing],
    )
    _locks[user.sid].challenge = opts.challenge
    return json.loads(options_to_json(opts))


class CredentialIn(BaseModel):
    credential: dict
    name: str = Field(default="", max_length=100)


@router.post("/passkey/register/verify")
async def passkey_register_verify(body: CredentialIn, user: User = Depends(member)):
    st = _locks[user.sid]
    if not st.challenge:
        raise HTTPException(400, "Start again.")
    try:
        v = verify_registration_response(credential=body.credential, expected_challenge=st.challenge,
                                         expected_rp_id=config.RP_ID, expected_origin=ORIGIN,
                                         require_user_verification=True)
    except InvalidRegistrationResponse as e:
        raise HTTPException(400, f"Face ID setup failed: {e}")
    finally:
        st.challenge = b""
    await pb.create("fin_passkeys", {"user": user.id, "cred_id": bytes_to_base64url(v.credential_id),
                                     "public_key": bytes_to_base64url(v.credential_public_key),
                                     "sign_count": v.sign_count, "name": body.name or "iPhone"})
    st.unlocked = True
    st.last_seen = time.monotonic()
    return {"ok": True}


@router.delete("/passkeys/{pid}")
async def delete_passkey(pid: str, user: User = Depends(member)):
    rec = await pb.get("fin_passkeys", rid(pid))
    if rec["user"] != user.id:
        raise HTTPException(404, "Not found.")
    await pb.delete("fin_passkeys", pid)
    return {"ok": True}


@router.post("/passkey/auth/options")
async def passkey_auth_options(user: User = Depends(signed_in)):
    keys = await user_passkeys(user.id)
    if not keys:
        raise HTTPException(400, "No Face ID set up for this account.")
    opts = generate_authentication_options(
        rp_id=config.RP_ID, user_verification=UserVerificationRequirement.REQUIRED,
        allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p["cred_id"])) for p in keys])
    _locks[user.sid].challenge = opts.challenge
    return json.loads(options_to_json(opts))


@router.post("/passkey/auth/verify")
async def passkey_auth_verify(body: CredentialIn, user: User = Depends(signed_in)):
    st = _locks[user.sid]
    if not st.challenge:
        raise HTTPException(400, "Start again.")
    cred_id = str(body.credential.get("id", ""))
    rec = await pb.first("fin_passkeys", f"cred_id = {q(cred_id)} && user = {q(user.id)}")
    if not rec:
        st.challenge = b""
        raise HTTPException(400, "Unknown passkey.")
    try:
        v = verify_authentication_response(
            credential=body.credential, expected_challenge=st.challenge, expected_rp_id=config.RP_ID,
            expected_origin=ORIGIN, credential_public_key=base64url_to_bytes(rec["public_key"]),
            credential_current_sign_count=int(rec.get("sign_count") or 0), require_user_verification=True)
    except InvalidAuthenticationResponse as e:
        raise HTTPException(400, f"Face ID check failed: {e}")
    finally:
        st.challenge = b""
    await pb.update("fin_passkeys", rec["id"], {"sign_count": v.new_sign_count})
    st.unlocked = True
    st.last_seen = time.monotonic()
    return {"ok": True}


@router.post("/lock")
async def lock_now(user: User = Depends(signed_in)):
    if await user_passkeys(user.id):
        _locks[user.sid].unlocked = False
    return {"ok": True}


# ---------------------------------------------------------------------------
# Email log (to see what arrived and how it was read)
# ---------------------------------------------------------------------------

@router.get("/emails")
async def email_log(samples: bool = False, user: User = Depends(member)):
    data = await pb.list("fin_emails", filter=f"is_sample = {'true' if samples else 'false'}", sort="-received_at",
                         per_page=50, fields="id,received_at,sender,subject,status,method,parsed,error,is_sample")
    return {"emails": data.get("items", [])}


@router.post("/emails/{eid}/retry")
async def email_retry(eid: str, user: User = Depends(admin)):
    from .emails import process_emails  # noqa: PLC0415
    await pb.update("fin_emails", rid(eid), {"status": "new"})
    await process_emails([eid])
    return await pb.get("fin_emails", eid)

