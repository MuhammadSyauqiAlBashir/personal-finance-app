"""Login sessions, household membership and the Face ID lock.

- `fin_session` cookie: the person's PocketBase token (httpOnly, SameSite=Strict).
  It proves who they are; checked with PocketBase's auth-refresh, which also
  enforces the shared `users` rule `approved = true`.
- Membership: admins always have access; everyone else must be in fin_members.
- Lock: a second cookie `fin_sid` names a server-side session. After
  LOCK_IDLE_SECONDS without requests, the API answers 423 until a passkey
  (Face ID) check succeeds. Lock sessions are also saved (hashed ids only) to
  STATE_DIR/lock_sessions.json so a restart or deploy doesn't lock everyone.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request, Response

from . import config
from .pb import pb, q

COOKIE = "fin_session"
SID_COOKIE = "fin_sid"
COOKIE_MAX_AGE = 30 * 24 * 3600
AUTH_TTL = 60  # seconds a verified token is trusted before re-checking


@dataclass
class User:
    id: str
    username: str
    role: str
    token: str
    sid: str = ""

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass
class LockState:
    user_id: str
    last_seen: float = field(default_factory=time.monotonic)
    unlocked: bool = False
    challenge: bytes = b""


_auth_cache: OrderedDict[str, tuple[float, dict, str]] = OrderedDict()
_locks: dict[str, LockState] = {}

# ---- lock sessions survive restarts --------------------------------------------------------------
_STORE = os.path.join(config.STATE_DIR, "lock_sessions.json")
_saved_at = 0.0


def _hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


def _load() -> dict:
    try:
        with open(_STORE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


_persisted: dict = _load()


def persist(force: bool = False):
    """Write the lock sessions (hashed ids, owner, last activity, unlocked) at most every 20 s."""
    global _saved_at
    now = time.monotonic()
    if not force and now - _saved_at < 20:
        return
    _saved_at = now
    wall = time.time()
    data = dict(_persisted)
    for sid, st in _locks.items():
        data[_hash(sid)] = {"u": st.user_id, "seen": wall - (now - st.last_seen), "unlocked": st.unlocked}
    data = {k: v for k, v in data.items() if wall - v.get("seen", 0) < 30 * 86400}
    try:
        tmp = _STORE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, _STORE)
    except OSError:
        pass


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def set_cookie(response: Response, name: str, value: str, max_age: int = COOKIE_MAX_AGE):
    response.set_cookie(name, value, max_age=max_age, httponly=True, secure=True, samesite="strict", path="/api")


def clear_session(response: Response):
    response.delete_cookie(COOKIE, path="/api")
    response.delete_cookie(SID_COOKIE, path="/api")


def forget_token(token: str):
    _auth_cache.pop(token, None)


def forget_all():
    _auth_cache.clear()


async def verify_token(token: str) -> tuple[dict, str] | None:
    hit = _auth_cache.get(token)
    if hit and time.monotonic() - hit[0] < AUTH_TTL:
        return hit[1], hit[2]
    status, data = await pb.raw("POST", "/api/collections/users/auth-refresh", token)
    if status != 200 or "token" not in data:
        _auth_cache.pop(token, None)
        return None
    user, new_token = data["record"], data["token"]
    for t in (token, new_token):
        _auth_cache[t] = (time.monotonic(), user, new_token)
        _auth_cache.move_to_end(t)
    while len(_auth_cache) > 500:
        _auth_cache.popitem(last=False)
    return user, new_token


async def is_member(user: dict) -> bool:
    if user.get("role") == "admin":
        # The owner always has access; make sure they're listed as a member.
        if not await pb.first("fin_members", f"user = {q(user['id'])}"):
            await pb.create("fin_members", {"user": user["id"], "username": user.get("username", "")})
        return True
    return bool(await pb.first("fin_members", f"user = {q(user['id'])}"))


def new_sid(user_id: str, unlocked: bool) -> str:
    sid = secrets.token_urlsafe(32)
    _locks[sid] = LockState(user_id=user_id, unlocked=unlocked)
    if len(_locks) > 1000:
        oldest = sorted(_locks.items(), key=lambda kv: kv[1].last_seen)[:200]
        for k, _ in oldest:
            _locks.pop(k, None)
    return sid


def lock_state(sid: str, user_id: str) -> LockState | None:
    st = _locks.get(sid)
    if not st and sid:
        rec = _persisted.get(_hash(sid))
        if rec and rec.get("u") == user_id:
            idle = max(0.0, time.time() - float(rec.get("seen", 0)))
            st = LockState(user_id=user_id, unlocked=bool(rec.get("unlocked")), last_seen=time.monotonic() - idle)
            _locks[sid] = st
    return st if st and st.user_id == user_id else None


async def signed_in(request: Request, response: Response) -> User:
    """A logged-in household member (the Face ID lock is not checked here)."""
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Please log in.")
    verified = await verify_token(token)
    if not verified:
        clear_session(response)
        raise HTTPException(401, "Your session has ended. Please log in again.")
    rec, fresh = verified
    if fresh != token:
        set_cookie(response, COOKIE, fresh)
    if (rec.get("role") or "") not in ("", "admin") or not await is_member(rec):  # machine logins
        raise HTTPException(403, "This account doesn't have access to the finance app. Ask the admin.")
    user = User(id=rec["id"], username=rec.get("username", ""), role=rec.get("role") or "user", token=fresh)
    sid = request.cookies.get(SID_COOKIE, "")
    st = lock_state(sid, user.id) if sid else None
    if not st:
        # Unknown session (new device or server restart): start locked if the
        # person has a passkey, unlocked otherwise.
        has_passkey = bool(await pb.first("fin_passkeys", f"user = {q(user.id)}"))
        sid = new_sid(user.id, unlocked=not has_passkey)
        set_cookie(response, SID_COOKIE, sid)
    user.sid = sid
    return user


async def member(user: User = Depends(signed_in)) -> User:
    """A logged-in household member whose session is unlocked (Face ID)."""
    st = _locks[user.sid]
    now = time.monotonic()
    if st.unlocked and now - st.last_seen > config.LOCK_IDLE_SECONDS:
        # Only lock if the person has a passkey to unlock with.
        if await pb.first("fin_passkeys", f"user = {q(user.id)}"):
            st.unlocked = False
    if not st.unlocked:
        persist()
        raise HTTPException(423, "Locked. Unlock with Face ID.")
    st.last_seen = now
    persist()
    return user


async def admin(user: User = Depends(member)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Admins only.")
    return user


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:16]
