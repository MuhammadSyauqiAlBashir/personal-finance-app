"""Gemini API client (REST). Free tier: on a rate limit, fall back to the next model."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

import httpx

from . import config

log = logging.getLogger("fin.ai")

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# Cheapest/highest-quota first for extraction; stronger models for advice.
FAST = [config.GEMINI_FAST_MODEL, "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.6-flash"]
# Free-tier models often hit short "high demand" spikes (503); try several before giving up.
SMART = [config.GEMINI_SMART_MODEL, "gemini-3.6-flash", "gemini-flash-latest", "gemini-3.8-flash",
         "gemini-3.7-flash", "gemini-3.1-flash-lite"]

_http: httpx.AsyncClient | None = None


class AIUnavailable(Exception):
    pass


def client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10))
    return _http


def money(value: Any) -> int:
    """Rupiah from an AI answer. Money fields are requested as text ("312450"):
    small models sometimes loop forever emitting digits inside JSON numbers."""
    from .parsers import parse_amount  # noqa: PLC0415
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return parse_amount(str(value)) or 0


MONEY = {"type": "string", "description": "rupiah, digits only, e.g. 125000"}


def image_part(data: bytes, mime: str) -> dict:
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}}


def _dedupe(models: list[str]) -> list[str]:
    seen, out = set(), []
    for m in models:
        if m and m not in seen:
            seen.add(m)
            out.append(m)
    return out


async def generate(parts: list[Any], *, system: str = "", schema: dict | None = None, smart: bool = False,
                   temperature: float = 0.2, history: list[dict] | None = None) -> Any:
    """Call Gemini. With `schema`, returns parsed JSON; otherwise text."""
    if not config.GEMINI_API_KEY:
        raise AIUnavailable("AI is not configured.")
    contents = list(history or [])
    contents.append({"role": "user", "parts": [p if isinstance(p, dict) else {"text": str(p)} for p in parts]})
    # Gemini 3 models should run at their default temperature (lower values make them loop), so
    # `temperature` is only sent for older models. The length cap stops a runaway answer early.
    config_: dict[str, Any] = {"maxOutputTokens": 4096 if schema else 8192}
    body: dict[str, Any] = {"contents": contents, "generationConfig": config_}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if schema:
        config_["responseMimeType"] = "application/json"
        config_["responseSchema"] = schema

    last_error = "no model answered"
    for model in _dedupe((config.GEMINI_SMART_MODEL if smart else config.GEMINI_FAST_MODEL,
                          *(SMART if smart else FAST))):
        for attempt in range(2):
            if "gemini-2" in model:
                config_["temperature"] = temperature
            else:
                config_.pop("temperature", None)
            try:
                r = await client().post(URL.format(model=model), json=body,
                                        headers={"x-goog-api-key": config.GEMINI_API_KEY})
            except httpx.HTTPError as e:
                last_error = f"{model}: {e}"
                await asyncio.sleep(2)
                continue
            if r.status_code == 200:
                data = r.json()
                try:
                    text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
                except (KeyError, IndexError):
                    last_error = f"{model}: empty answer ({data.get('promptFeedback', {})})"
                    break
                if schema:
                    try:
                        return json.loads(text)
                    except ValueError:
                        last_error = f"{model}: invalid JSON"
                        break
                return text
            last_error = f"{model}: HTTP {r.status_code} {r.text[:200]}"
            if r.status_code == 500 and attempt == 0:
                await asyncio.sleep(1)  # one quick retry for a transient error
                continue
            break  # 429 quota, 503 overloaded, 404 unknown model: try the next model
        log.warning("gemini fallback: %s", last_error)
    raise AIUnavailable(last_error)
