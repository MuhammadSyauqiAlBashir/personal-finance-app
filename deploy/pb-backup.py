#!/usr/bin/env python3
"""Daily backup of the shared PocketBase (every app's data) into one zip.

Runs at 01:00 from pb-backup.timer as the `pocketbase` user. The live database is only read: SQLite's online backup
API makes a consistent copy while PocketBase keeps running. The copy is integrity-checked, then zipped with the
uploaded files (storage/), hooks and migrations into /var/backups/pocketbase/pocketbase-backup-YYYY-MM-DD.zip (group
`finance`: the finance app hands it to the Gmail Apps Script, which saves it in the finance Google Drive and keeps
28 days there). Zips here older than KEEP_DAYS are removed (only files with exactly that name pattern).
PocketBase's auxiliary.db (request logs) is left out: it's large and not needed to restore.
"""

import datetime
import os
import re
import sqlite3
import sys
import tempfile
import zipfile

PB = os.environ.get("PB_BACKUP_SRC", "/var/lib/pocketbase")  # overridable only for tests on a scratch copy
OUT = os.environ.get("PB_BACKUP_OUT", "/var/backups/pocketbase")
KEEP_DAYS = 7
NAME = re.compile(r"^pocketbase-backup-(\d{4}-\d{2}-\d{2})\.zip$")
APPS_SCRIPT_LIMIT = 50_000_000  # UrlFetchApp can't download more than this in one go

README = """PocketBase backup {date}: the whole shared database on seras-server (finance, lyrsync, shop, BashGames,
user accounts) plus uploaded files (receipts, images), hooks and migrations. No passwords in plain text: user
passwords are stored as hashes. Not included: auxiliary.db (request logs).

Restore on the server (keep a second SSH session or the Biznet console open):
  1. sudo systemctl stop finance lyrsync shop-web shop-admin bashgames pocketbase
  2. sudo cp -a /var/lib/pocketbase/pb_data /var/lib/pocketbase/pb_data.before-restore
  3. unzip this file into an empty folder, e.g. ~/work/restore
  4. sudo rm -f /var/lib/pocketbase/pb_data/data.db-wal /var/lib/pocketbase/pb_data/data.db-shm
     sudo cp ~/work/restore/pb_data/data.db /var/lib/pocketbase/pb_data/data.db
     sudo rsync -a --delete ~/work/restore/pb_data/storage/ /var/lib/pocketbase/pb_data/storage/
     sudo chown -R pocketbase:pocketbase /var/lib/pocketbase/pb_data
  5. sudo systemctl start pocketbase finance lyrsync shop-web shop-admin bashgames
     systemctl is-active pocketbase finance lyrsync shop-web shop-admin bashgames
"""


def main() -> int:
    today = datetime.date.today()
    final = os.path.join(OUT, f"pocketbase-backup-{today}.zip")
    part = final + ".part"
    with tempfile.TemporaryDirectory() as tmp:
        snap = os.path.join(tmp, "data.db")
        src = sqlite3.connect(f"file:{PB}/pb_data/data.db?mode=ro", uri=True)
        dst = sqlite3.connect(snap)
        src.backup(dst)
        src.close()
        check = dst.execute("PRAGMA integrity_check").fetchone()[0]
        tables = dst.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0]
        dst.close()
        if check != "ok":
            print(f"copy failed the integrity check: {check}", file=sys.stderr)
            return 1
        with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.writestr("README.txt", README.format(date=today))
            z.write(snap, "pb_data/data.db")
            for sub in ("pb_data/storage", "pb_hooks", "pb_migrations"):
                for root, _dirs, files in os.walk(os.path.join(PB, sub)):
                    for f in sorted(files):
                        path = os.path.join(root, f)
                        z.write(path, os.path.relpath(path, PB))
        with zipfile.ZipFile(part) as z:
            bad = z.testzip()
        if bad:
            os.remove(part)
            print(f"zip check failed at {bad}", file=sys.stderr)
            return 1
        os.replace(part, final)
    size = os.path.getsize(final)
    print(f"wrote {final}: {size / 1e6:.1f} MB, {tables} tables, integrity ok")
    if size > APPS_SCRIPT_LIMIT * 0.8:
        print(f"WARNING: {size / 1e6:.0f} MB is close to the 50 MB the Apps Script can download", file=sys.stderr)

    cutoff = today - datetime.timedelta(days=KEEP_DAYS)
    for name in os.listdir(OUT):
        m = NAME.match(name)
        if m and datetime.date.fromisoformat(m.group(1)) < cutoff:
            os.remove(os.path.join(OUT, name))
            print(f"removed local {name} (older than {KEEP_DAYS} days)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
