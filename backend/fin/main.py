"""Financial Management backend (FastAPI on 127.0.0.1:8100, behind Caddy)."""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import ingest
from .pb import PBError, pb
from .security import COOKIE, User, clear_session, client_ip, forget_token, set_cookie, signed_in

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("fin")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await pb.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(ingest.router)


# ---------------------------------------------------------------------------
# Errors, CSRF, caching
# ---------------------------------------------------------------------------

@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    body = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
    headers = {"Retry-After": str(body["retry_after"])} if "retry_after" in body else None
    return JSONResponse(body, status_code=exc.status_code, headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = str(first.get("loc", ["", "input"])[-1])
    return JSONResponse({"error": f"Invalid {field}: {first.get('msg', 'bad value')}."}, status_code=400)


@app.exception_handler(PBError)
async def pb_error(request: Request, exc: PBError):
    log.warning("pocketbase error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse({"error": exc.field_error()}, status_code=400 if exc.status < 500 else 502)


@app.middleware("http")
async def csrf_and_cache(request: Request, call_next):
    # Cookie-authenticated writes need a header cross-site forms can't send.
    # The ingest endpoint is authenticated by its HMAC signature instead.
    if (request.method not in ("GET", "HEAD") and not request.url.path.startswith("/api/ingest/")
            and request.headers.get("x-fin") != "1"):
        return JSONResponse({"error": "Missing request header."}, status_code=403)
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    return response


# ---------------------------------------------------------------------------
# Rate limiting (in memory)
# ---------------------------------------------------------------------------

class Window:
    def __init__(self, limit: int, seconds: float):
        self.limit, self.seconds = limit, seconds
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, what: str):
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > self.seconds:
            q.popleft()
        if len(q) >= self.limit:
            wait = int(self.seconds - (now - q[0])) + 1
            raise HTTPException(429, {"error": f"Too many {what}. Try again in {wait}s.", "retry_after": wait})
        q.append(now)


login_limit = Window(10, 600)


# ---------------------------------------------------------------------------
# Accounts (shared PocketBase users; register/approve happens in lyrsync)
# ---------------------------------------------------------------------------

class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=72)


def public_user(u: User) -> dict:
    return {"id": u.id, "username": u.username, "role": u.role}


@app.post("/api/login")
async def login(body: Credentials, request: Request, response: Response):
    login_limit.check(client_ip(request), "login attempts")
    status, data = await pb.raw("POST", "/api/collections/users/auth-with-password", json={
        "identity": body.username.strip().lower(), "password": body.password})
    if status == 403:
        raise HTTPException(403, "Your account is waiting for approval.")
    if status != 200:
        raise HTTPException(401, "Wrong username or password.")
    if data["record"].get("role") == "service":
        raise HTTPException(401, "Wrong username or password.")
    set_cookie(response, COOKIE, data["token"])
    request.cookies[COOKIE] = data["token"]
    user = await signed_in(request, response)
    return {"user": public_user(user)}


@app.post("/api/logout")
async def logout(request: Request, response: Response):
    forget_token(request.cookies.get(COOKIE, ""))
    clear_session(response)
    return {"ok": True}


@app.get("/api/me")
async def me(user: User = Depends(signed_in)):
    from .security import _locks  # noqa: PLC0415
    return {"user": public_user(user), "locked": not _locks[user.sid].unlocked}


@app.get("/api/health")
async def health():
    return {"ok": True}
