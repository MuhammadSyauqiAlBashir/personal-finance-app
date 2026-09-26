"""Rule-based readers for BCA and Mandiri notification emails.

Each reader returns a Parsed result, a Skip (not a transaction, e.g. a login
alert), or None (layout not recognised, so the AI fallback takes over).
Text arrives already redacted (long numbers keep their last 4 digits).
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime

from .config import TZ

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "mei": 5, "jun": 6, "jul": 7, "aug": 8, "agu": 8,
    "agt": 8, "sep": 9, "oct": 10, "okt": 10, "nov": 11, "dec": 12, "des": 12,
}
WALLETS = {"GOPAY": "GoPay", "OVO": "OVO", "SHOPEEPAY": "ShopeePay", "DANA": "DANA", "LINKAJA": "LinkAja",
           "FLIP": "Flip", "ASTRAPAY": "AstraPay", "ISAKU": "i.saku"}
AMOUNT_RE = re.compile(r"(?:Rp\.?|IDR)\s*([0-9][0-9.,]*)", re.I)


@dataclass
class Parsed:
    bank: str
    status: str  # success | failed
    kind: str  # expense | transfer | topup
    amount: int  # total that left the account, fees included
    occurred_at: str  # ISO 8601 with +07:00
    merchant: str = ""
    description: str = ""
    account: str = ""  # e.g. "BCA …11"
    holder: str = ""  # account holder name from the greeting
    beneficiary: str = ""
    wallet: str = ""  # e-wallet name for top-ups
    fee: int = 0
    fields: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Skip:
    reason: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_amount(text: str) -> int | None:
    """'IDR 82,000.00' -> 82000, 'Rp 7.475.000,00' -> 7475000, 'Rp 13.005' -> 13005."""
    m = AMOUNT_RE.search(text or "")
    s = m.group(1) if m else (text or "").strip()
    s = s.rstrip(".,")
    if not re.search(r"\d", s):
        return None
    dec = re.search(r"[.,](\d{1,2})$", s)
    if dec:
        s = s[: dec.start()]
    digits = re.sub(r"[^\d]", "", s)
    return int(digits) if digits else None


def all_amounts(text: str) -> set[int]:
    """Every Rp/IDR amount written in the text (used to check the AI's answer)."""
    out = set()
    for m in AMOUNT_RE.finditer(text or ""):
        v = parse_amount(m.group(0))
        if v is not None:
            out.add(v)
    return out


def parse_date(day_month_year: str, time_str: str = "") -> str | None:
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})(?:\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?", day_month_year)
    if not m:
        return None
    month = MONTHS.get(m.group(2)[:3].lower())
    if not month:
        return None
    hh, mm, ss = m.group(4), m.group(5), m.group(6)
    if not hh and time_str:
        t = re.search(r"(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?", time_str)
        if t:
            hh, mm, ss = t.group(1), t.group(2), t.group(3)
    dt = datetime(int(m.group(3)), month, int(m.group(1)), int(hh or 0), int(mm or 0), int(ss or 0), tzinfo=TZ)
    return dt.isoformat()


def norm_name(s: str) -> str:
    return re.sub(r"[^A-Z ]", "", (s or "").upper()).strip()


def same_person(a: str, b: str) -> bool:
    """Bank emails truncate names ('MUHAMMAD SYAUQI AL B'); compare as prefixes."""
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return False
    if a == "OWNER" or b == "OWNER":  # redacted household name
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 8 and long_.startswith(short)


def wallet_of(*texts: str) -> str:
    joined = " ".join(texts).upper().replace(" ", "").replace("-", "")
    for key, name in WALLETS.items():
        if key in joined:
            return name
    return ""


def unwrap_forward(sender: str, subject: str, body: str) -> tuple[str, str, str]:
    """Hand-forwarded samples: use the original sender/subject and body."""
    marker = "---------- Forwarded message ---------"
    if marker not in body:
        return sender, subject, body
    rest = body.split(marker, 1)[1]
    head, _, content = rest.partition("\n\n")
    orig_from = re.search(r"^From:\s*(.+)$", head, re.M)
    orig_subj = re.search(r"^Subject:\s*(.+)$", head, re.M)
    return (orig_from.group(1).strip() if orig_from else sender,
            orig_subj.group(1).strip() if orig_subj else re.sub(r"^(Fwd?|FW):\s*", "", subject, flags=re.I),
            content)


def greeting_name(body: str) -> str:
    m = re.search(r"^(?:Hello|Hi|Halo|Dear|Yth\.?)\s+([^,\n]+),", body, re.M | re.I)
    return m.group(1).strip() if m else ""


# ---------------------------------------------------------------------------
# BCA
# ---------------------------------------------------------------------------

BCA_KEYS = {
    "status": ("status",),
    "date": ("transaction date", "tanggal transaksi", "date", "tanggal"),
    "type": ("transfer type", "transaction type", "jenis transfer", "jenis transaksi"),
    "payee": ("payment to", "beneficiary name", "company/product name", "nama penerima", "pembayaran ke",
              "merchant name", "nama merchant", "name", "nama"),
    "total": ("total payment", "total pembayaran", "total transaksi", "total amount", "total"),
    "amount": ("transfer amount", "jumlah transfer", "pay amount", "amount", "nominal", "jumlah"),
    "fee": ("admin fee", "biaya admin", "fee", "biaya"),
    "source": ("source of fund", "sumber dana", "rekening sumber"),
    "remarks": ("remarks", "description", "berita", "keterangan"),
}


def kv_lines(body: str) -> dict[str, str]:
    out = {}
    for line in body.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip().lower(), v.strip()
        if k and len(k) <= 40 and k not in out:
            out[k] = v
    return out


def pick(kv: dict[str, str], names: tuple[str, ...]) -> str:
    for n in names:
        if kv.get(n):
            return kv[n]
    return ""


def last_digits(s: str) -> str:
    m = re.search(r"(\d{2,4})\s*$", s or "")
    return m.group(1) if m else ""


def parse_bca(subject: str, body: str) -> Parsed | Skip | None:
    kv = kv_lines(body)
    f = {name: pick(kv, keys) for name, keys in BCA_KEYS.items()}
    total = parse_amount(f["total"]) or parse_amount(f["amount"])
    when = parse_date(f["date"])
    if total is None or not when:
        return None
    status_text = (f["status"] + " " + subject).lower()
    failed = any(w in status_text for w in ("tidak berhasil", "unsuccessful", "failed", "gagal"))
    ttype = f["type"]
    payee = f["payee"]
    if f["type"].lower().startswith("transfer to bca virtual") and kv.get("company/product name"):
        payee = kv["company/product name"]
    holder = greeting_name(body)
    kind, wallet = "expense", wallet_of(payee, ttype)
    if wallet and ("top" in (payee + ttype).lower() or "virtual account" in ttype.lower()):
        kind = "topup"
    elif "transfer" in ttype.lower() and same_person(payee, holder):
        kind = "transfer"
    if "cash withdrawal" in subject.lower() or "tarik tunai" in subject.lower():
        ttype = ttype or "Cash withdrawal"
        payee = payee or "Cash withdrawal"
    return Parsed(
        bank="BCA", status="failed" if failed else "success", kind=kind, amount=total, occurred_at=when,
        merchant=payee[:200], description=ttype[:200], account=f"BCA …{last_digits(f['source'])}".rstrip("…"),
        holder=holder, beneficiary=payee if kind == "transfer" else "", wallet=wallet,
        fee=parse_amount(f["fee"]) or 0, fields={k: v for k, v in f.items() if v},
    )


# ---------------------------------------------------------------------------
# Mandiri (Livin')
# ---------------------------------------------------------------------------

MANDIRI_SKIP = ("akses terbaru", "password", "kata sandi", "login", "otp", "perangkat baru", "pin berhasil")
MANDIRI_PARTY = ("penerima", "penyedia jasa", "merchant", "nama merchant", "tujuan", "pembayaran ke", "tagihan")


def lines_of(body: str) -> list[str]:
    return [ln.strip() for ln in body.splitlines() if ln.strip() and not ln.strip().startswith("[image")]


def after(lines: list[str], label: str, n: int = 1) -> list[str]:
    for i, ln in enumerate(lines):
        if ln.lower() == label:
            return lines[i + 1 : i + 1 + n]
    return []


def labelled(lines: list[str], prefix: str) -> str:
    """Value of a 'Label value' line, e.g. 'Nominal Transfer Rp 7.475.000,00'."""
    for ln in lines:
        if ln.lower().startswith(prefix):
            return ln
    return ""


def parse_mandiri(subject: str, body: str) -> Parsed | Skip | None:
    s = subject.lower()
    if any(w in s for w in MANDIRI_SKIP):
        return Skip("not a transaction")
    lines = lines_of(body)
    total = parse_amount(labelled(lines, "total transaksi")) or parse_amount(labelled(lines, "total"))
    if total is None:
        nominal = labelled(lines, "nominal")
        total = parse_amount(nominal)
    when = parse_date(labelled(lines, "tanggal"), labelled(lines, "jam"))
    if total is None or not when:
        return None
    failed = any(w in s for w in ("tidak berhasil", "gagal"))
    party, party_extra = "", ""
    for label in MANDIRI_PARTY:
        got = after(lines, label, 2)
        if got:
            party = got[0]
            party_extra = got[1] if len(got) > 1 else ""
            break
    source = after(lines, "rekening sumber", 2)
    holder = greeting_name(body)
    kind, wallet = "expense", wallet_of(party, subject)
    if wallet and "top" in s:
        kind = "topup"
    elif "transfer" in s and same_person(party, holder):
        kind = "transfer"
    fee = parse_amount(labelled(lines, "biaya")) or 0
    return Parsed(
        bank="Mandiri", status="failed" if failed else "success", kind=kind, amount=total, occurred_at=when,
        merchant=party[:200], description=subject[:200],
        account=f"Mandiri …{last_digits(source[-1] if source else '')}".rstrip("…"),
        holder=holder, beneficiary=party if kind == "transfer" else "", wallet=wallet, fee=fee,
        fields={"party_detail": party_extra, "nominal": labelled(lines, "nominal"), "fee": labelled(lines, "biaya")},
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def parse_email(sender: str, subject: str, body: str) -> tuple[str, str, Parsed | Skip | None]:
    """Returns (original sender, original subject, result)."""
    body = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    sender, subject, body = unwrap_forward(sender, subject, body)
    s = sender.lower()
    if "bca.co.id" in s or "klikbca.com" in s:
        if "halobca" in s:
            return sender, subject, Skip("Halo BCA message")
        return sender, subject, parse_bca(subject, body)
    if "bankmandiri.co.id" in s:
        return sender, subject, parse_mandiri(subject, body)
    return sender, subject, None
