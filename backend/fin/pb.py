"""PocketBase access.

The backend reads and writes fin_* collections as the service user. People are
authenticated separately (see security.py) and never get the service token.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from . import config

log = logging.getLogger("fin.pb")


class PBError(Exception):
    def __init__(self, status: int, data: Any):
        super().__init__(f"pocketbase {status}: {data}")
        self.status = status
        self.data = data

    def field_error(self) -> str:
        fields = (self.data or {}).get("data") or {}
        for name, err in fields.items():
            if isinstance(err, dict) and err.get("message"):
                return f"{name}: {err['message']}"
        return (self.data or {}).get("message") or "Database error."


def q(value: str) -> str:
    """Quote a value for a PocketBase filter string."""
    return json.dumps(str(value))


class PocketBase:
    def __init__(self):
        self.http = httpx.AsyncClient(base_url=config.PB_URL, timeout=20)
        self._token = ""
        self._lock = asyncio.Lock()

    async def close(self):
        await self.http.aclose()

    # ---- raw ------------------------------------------------------------
    async def raw(self, method: str, path: str, token: str | None = None, **kw) -> tuple[int, Any]:
        headers = kw.pop("headers", {})
        if token:
            headers["Authorization"] = token
        r = await self.http.request(method, path, headers=headers, **kw)
        try:
            data = r.json() if r.content else {}
        except ValueError:
            data = {}
        return r.status_code, data

    # ---- service session ------------------------------------------------
    async def _login(self):
        status, data = await self.raw("POST", "/api/collections/users/auth-with-password", json={
            "identity": config.PB_SERVICE_USER, "password": config.PB_SERVICE_PASSWORD})
        if status != 200:
            raise PBError(status, data)
        self._token = data["token"]

    async def call(self, method: str, path: str, **kw) -> Any:
        if not self._token:
            async with self._lock:
                if not self._token:
                    await self._login()
        status, data = await self.raw(method, path, self._token, **kw)
        if status == 401:
            async with self._lock:
                await self._login()
            status, data = await self.raw(method, path, self._token, **kw)
        if status >= 400:
            raise PBError(status, data)
        return data

    # ---- record helpers -------------------------------------------------
    async def list(self, collection: str, *, filter: str = "", sort: str = "", page: int = 1, per_page: int = 200,
                   expand: str = "", fields: str = "", skip_total: bool = True) -> dict:
        params: dict[str, Any] = {"page": page, "perPage": per_page}
        if filter:
            params["filter"] = filter
        if sort:
            params["sort"] = sort
        if expand:
            params["expand"] = expand
        if fields:
            params["fields"] = fields
        if skip_total:
            params["skipTotal"] = 1
        return await self.call("GET", f"/api/collections/{collection}/records", params=params)

    async def all(self, collection: str, **kw) -> list[dict]:
        items, page = [], 1
        while True:
            data = await self.list(collection, page=page, per_page=500, **kw)
            batch = data.get("items", [])
            items.extend(batch)
            if len(batch) < 500:
                return items
            page += 1

    async def first(self, collection: str, filter: str, sort: str = "") -> dict | None:
        items = (await self.list(collection, filter=filter, sort=sort, per_page=1)).get("items", [])
        return items[0] if items else None

    async def get(self, collection: str, record_id: str, expand: str = "") -> dict:
        params = {"expand": expand} if expand else None
        return await self.call("GET", f"/api/collections/{collection}/records/{record_id}", params=params)

    async def create(self, collection: str, data: dict, files: dict | None = None) -> dict:
        if files:
            form = {k: (json.dumps(v) if isinstance(v, (dict, list)) else str(v)) for k, v in data.items()
                    if v is not None}
            return await self.call("POST", f"/api/collections/{collection}/records", data=form, files=files)
        return await self.call("POST", f"/api/collections/{collection}/records", json=data)

    async def update(self, collection: str, record_id: str, data: dict) -> dict:
        return await self.call("PATCH", f"/api/collections/{collection}/records/{record_id}", json=data)

    async def delete(self, collection: str, record_id: str):
        await self.call("DELETE", f"/api/collections/{collection}/records/{record_id}")

    async def file_token(self) -> str:
        return (await self.call("POST", "/api/files/token"))["token"]

    async def file_bytes(self, collection: str, record_id: str, filename: str, thumb: str = "") -> tuple[bytes, str]:
        params = {"token": await self.file_token()}
        if thumb:
            params["thumb"] = thumb
        r = await self.http.get(f"/api/files/{collection}/{record_id}/{filename}", params=params)
        if r.status_code != 200:
            raise PBError(r.status_code, {})
        return r.content, r.headers.get("content-type", "application/octet-stream")

    # ---- key/value ------------------------------------------------------
    async def kv_get(self, key: str, default: Any = None) -> Any:
        rec = await self.first("fin_kv", f"key = {q(key)}")
        return rec["value"] if rec and rec.get("value") is not None else default

    async def kv_set(self, key: str, value: Any):
        rec = await self.first("fin_kv", f"key = {q(key)}")
        if rec:
            await self.update("fin_kv", rec["id"], {"value": value})
        else:
            await self.create("fin_kv", {"key": key, "value": value})

    async def event_once(self, key: str) -> bool:
        """Record a one-off event. True the first time, False if already recorded."""
        try:
            await self.create("fin_events", {"key": key[:200]})
            return True
        except PBError as e:
            if e.status == 400:
                return False
            raise


pb = PocketBase()
