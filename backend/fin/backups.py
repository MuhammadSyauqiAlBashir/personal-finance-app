"""Daily backups of the shared PocketBase, handed to the Gmail Apps Script for Google Drive.

deploy/pb-backup.py (pb-backup.timer, 01:00) writes one zip a day into BACKUP_DIR, readable by this app's group.
The Apps Script lists the ones not yet in Drive (signed requests, see ingest.py), downloads each, saves it in
"Financial Management/Backups/" and reports the Drive file id back; it also trashes Drive backups older than
DRIVE_KEEP_DAYS. Which files reached Drive is kept in STATE_DIR (not in PocketBase, so it's still there when the
database is the thing being restored). This module only reads the backup files; it never touches the database.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta

from fastapi import HTTPException

from . import config

NAME = re.compile(r"^pocketbase-backup-(\d{4}-\d{2}-\d{2})\.zip$")
DRIVE_KEEP_DAYS = 28
STATE = os.path.join(config.STATE_DIR, "backups_uploaded.json")


def path_for(name: str) -> str:
    if not NAME.match(name or ""):
        raise HTTPException(404, "Not found.")
    path = os.path.join(config.BACKUP_DIR, name)
    if not os.path.isfile(path):
        raise HTTPException(404, "Not found.")
    return path


def local_names() -> list[str]:
    try:
        return sorted(n for n in os.listdir(config.BACKUP_DIR) if NAME.match(n))
    except OSError:
        return []


def uploaded() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def mark_uploaded(name: str, drive_file_id: str):
    done = uploaded()
    done[name] = {"drive_file_id": drive_file_id, "at": datetime.now(config.TZ).isoformat(timespec="seconds")}
    # Forget entries well past the Drive retention (their files are gone everywhere by then).
    cutoff = (datetime.now(config.TZ) - timedelta(days=DRIVE_KEEP_DAYS + 30)).strftime("%Y-%m-%d")
    done = {k: v for k, v in done.items() if (m := NAME.match(k)) and m.group(1) >= cutoff}
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(done, f, indent=1)
    os.replace(tmp, STATE)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def queue() -> list[dict]:
    """Backups on the server that aren't in Drive yet, oldest first."""
    done = uploaded()
    items = []
    for name in local_names():
        if name in done:
            continue
        path = os.path.join(config.BACKUP_DIR, name)
        items.append({"name": name, "size": os.path.getsize(path), "sha256": sha256(path)})
    return items


def status() -> dict:
    done = uploaded()
    last = max(done, default="")
    return {"last": {"name": last, **done[last]} if last else None, "waiting": len(queue()),
            "drive_keep_days": DRIVE_KEEP_DAYS, "folder": "Financial Management/Backups"}


def days_since_last_upload() -> int | None:
    last = max(uploaded(), default="")
    m = NAME.match(last)
    if not m:
        return None
    return (datetime.now(config.TZ).date() - datetime.strptime(m.group(1), "%Y-%m-%d").date()).days
