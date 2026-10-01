"""Bank-email details shown in the Inbox (read-only extraction)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fin.details import account_key, email_details  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def det(name, crlf=False):
    d = json.loads((FIX / f"{name}.json").read_text())
    body = d["body"].replace("\n", "\r\n") if crlf else d["body"]
    return email_details(d["sender"], d["subject"], body)


def test_bca_qris():
    d = det("bca_qris")
    assert d["bank"] == "BCA" and d["to"]["name"] and d["total"]
    assert d["from"]["label"].startswith("BCA ••")


def test_bca_va_topup_has_fee_and_company():
    d = det("bca_va_gopay_topup")
    assert d["fee"] and d["total"] == d["amount"] + d["fee"]
    assert "GOPAY" in d["to"]["name"].upper()


def test_mandiri_bifast_recipient_bank():
    for crlf in (False, True):  # forwarded emails arrive with Windows line breaks
        d = det("mandiri_bifast_own", crlf)
        assert d["bank"] == "Mandiri"
        assert d["to"]["bank"] == "BCA" and d["to"]["account"].startswith("••")
        assert d["amount"] and d["fee"] and d["total"]
        assert d["from"]["account"].startswith("••")


def test_account_key():
    assert account_key("BCA …73") == "BCA:73"
    assert account_key("BCA ••73") == "BCA:73"
    assert account_key("Mandiri …8139") == "Mandiri:8139"
    assert account_key("Cash") == ""
