"""Settings from the environment (/etc/finance/env via systemd EnvironmentFile)."""

import os
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Jakarta")

PB_URL = os.environ.get("FIN_PB_URL", "http://127.0.0.1:8090")
PB_SERVICE_USER = os.environ.get("FIN_PB_SERVICE_USER", "svc_finance")
PB_SERVICE_PASSWORD = os.environ.get("FIN_PB_SERVICE_PASSWORD", "")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_FAST_MODEL = os.environ.get("FIN_GEMINI_FAST_MODEL", "gemini-3.1-flash-lite")
GEMINI_SMART_MODEL = os.environ.get("FIN_GEMINI_SMART_MODEL", "gemini-3.5-flash")

# Shared with the Gmail Apps Script; signs every ingest request.
INGEST_SECRET = os.environ.get("FIN_INGEST_SECRET", "")

# Web Push (VAPID). Private key is a PEM file path or base64url raw key.
VAPID_PRIVATE_KEY = os.environ.get("FIN_VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("FIN_VAPID_PUBLIC_KEY", "")
VAPID_SUBJECT = os.environ.get("FIN_VAPID_SUBJECT", "https://financial-management.bashir.my.id")

# Google Drive (OAuth client for the finance inbox account, drive.file scope).
GOOGLE_CLIENT_ID = os.environ.get("FIN_GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("FIN_GOOGLE_CLIENT_SECRET", "")

PUBLIC_URL = os.environ.get("FIN_PUBLIC_URL", "https://financial-management.bashir.my.id")
RP_ID = os.environ.get("FIN_RP_ID", "financial-management.bashir.my.id")  # passkeys

PAYDAY = int(os.environ.get("FIN_PAYDAY", "25"))
LOCK_IDLE_SECONDS = int(os.environ.get("FIN_LOCK_IDLE_SECONDS", "300"))

# State the backend writes itself (Drive refresh token). Kept outside PocketBase
# so a database leak doesn't include it.
STATE_DIR = os.environ.get("FIN_STATE_DIR", "/var/lib/finance")
