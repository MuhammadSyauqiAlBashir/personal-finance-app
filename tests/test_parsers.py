"""Parser tests against real (name-scrubbed) bank emails in tests/fixtures."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fin.parsers import Parsed, Skip, all_amounts, parse_amount, parse_email, same_person  # noqa: E402
from fin.redact import redact  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def load(name):
    d = json.loads((FIX / f"{name}.json").read_text())
    return parse_email(d["sender"], d["subject"], d["body"])


def test_amounts():
    assert parse_amount("IDR 82,000.00") == 82000
    assert parse_amount("Rp 7.475.000,00") == 7475000
    assert parse_amount("Rp 13.005") == 13005
    assert parse_amount("Rp13.005,5") == 13005
    assert parse_amount("IDR 1,250,000") == 1250000
    assert parse_amount("nothing") is None
    assert all_amounts("Pay IDR 82,000.00 fee IDR 1,000.00 total IDR 83,000.00") == {82000, 1000, 83000}


def test_names():
    assert same_person("BUDI SANTOSO PRATAMAWAT", "BUDI SANTOSO PRATAMAWATI")
    assert same_person("BUDI SANTOSO PR", "BUDI SANTOSO PRATAMAWATI")
    assert not same_person("SITI AMINAH", "BUDI SANTOSO PRATAMAWATI")
    assert not same_person("BUDI", "BUDI SANTOSO")  # too short to trust


def test_redact():
    out = redact("Rek 1234567890 kartu 4556 7788 9900 1122 total Rp 12.500.000,00 x@y.com")
    assert "******7890" in out and "************1122" in out
    assert "Rp 12.500.000,00" in out and "[email]" in out


def test_bca_va_gopay_topup():
    sender, subject, p = load("bca_va_gopay_topup")
    assert "bca.co.id" in sender and subject == "Internet Transaction Journal"
    assert isinstance(p, Parsed)
    assert (p.bank, p.status, p.kind, p.wallet) == ("BCA", "success", "topup", "GoPay")
    assert p.amount == 83000 and p.fee == 1000
    assert p.occurred_at == "2026-09-26T14:13:59+07:00"
    assert "GOPAY" in p.merchant and p.account == "BCA …11"


def test_bca_qris():
    _, _, p = load("bca_qris")
    assert (p.kind, p.status, p.amount, p.merchant) == ("expense", "success", 13005, "Domainesia")
    assert p.description == "QRIS Payment"
    assert p.occurred_at == "2026-09-26T09:11:02+07:00"


def test_bca_transfer_to_someone_else():
    _, _, p = load("bca_transfer")
    assert (p.kind, p.amount, p.merchant) == ("expense", 250000, "SITI AMINAH")
    assert p.occurred_at == "2026-09-25T17:28:10+07:00"


def test_mandiri_bifast_to_own_account():
    _, subject, p = load("mandiri_bifast_own")
    assert subject == "Transfer dengan BI Fast Berhasil"
    assert (p.bank, p.kind, p.status) == ("Mandiri", "transfer", "success")
    assert p.amount == 7477500 and p.fee == 2500
    assert p.occurred_at == "2026-09-25T08:57:05+07:00"
    assert p.account == "Mandiri …8139"


def test_mandiri_topup():
    _, _, p = load("mandiri_topup_gopay")
    assert (p.kind, p.wallet, p.amount, p.fee) == ("topup", "GoPay", 201200, 1200)
    assert p.occurred_at == "2026-09-05T19:39:03+07:00"


def test_mandiri_login_alert_skipped():
    _, _, p = parse_email("Livin' <noreply.livin@bankmandiri.co.id>", "Akses Terbaru ke Livin' by Mandiri", "Halo X,")
    assert isinstance(p, Skip)


def test_mandiri_failed():
    body = ("Pembayaran Tidak Berhasil\n\nHalo BUDI SANTOSO,\n\nMerchant\nWARUNG MAJU\n\nTanggal 1 Okt 2026\n"
            "Jam 12:00:00 WIB\nTotal Transaksi Rp 45.000,00\n")
    _, _, p = parse_email("noreply.livin@bankmandiri.co.id", "Pembayaran Tidak Berhasil", body)
    assert (p.status, p.amount, p.merchant, p.occurred_at[:10]) == ("failed", 45000, "WARUNG MAJU", "2026-10-01")


def test_unknown_sender_falls_back():
    _, _, p = parse_email("promo@shop.com", "Hi", "Rp 10.000")
    assert p is None
