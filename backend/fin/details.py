"""Everything a bank email says about a transaction, worked out at read time from the stored (redacted) email.

Nothing is written back: the Inbox detail screen calls this when it opens a transaction. Works for BCA (myBCA /
KlikBCA "Key : Value" emails) and Mandiri Livin' (label lines); anything unknown still shows up in "all fields".
"""

from __future__ import annotations

import re

from .parsers import kv_lines, last_digits, lines_of, parse_amount

BANK_NAMES = {"bank central asia": "BCA", "bca": "BCA", "bank mandiri": "Mandiri", "mandiri": "Mandiri", "bank negara indonesia": "BNI",
              "bni": "BNI", "bank rakyat indonesia": "BRI", "bri": "BRI", "cimb": "CIMB Niaga", "permata": "Permata",
              "bank syariah indonesia": "BSI", "bsi": "BSI", "jago": "Jago", "seabank": "SeaBank", "btn": "BTN", "danamon": "Danamon"}
NOISE = ("please save", "if you do not", "best regards", "this email", "for inquiries", "please contact", "note(s)",
         "fees include", "npwp", "hello", "halo", "you just made", "here are the details", "berikut adalah", "simpan email")


def short_bank(text: str) -> str:
    t = (text or "").lower()
    for k, v in BANK_NAMES.items():
        if k in t:
            return v
    return ""


def masked(num: str) -> str:
    d = last_digits(num or "")
    return f"••{d}" if d else ""


def money(text: str) -> int | None:
    return parse_amount(text) if text else None


def bca_details(body: str) -> dict:
    kv = kv_lines(body)
    get = lambda *names: next((kv[n] for n in names if kv.get(n)), "")  # noqa: E731
    d: dict = {"bank": "BCA", "channel": "myBCA / KlikBCA"}
    d["status"] = get("status")
    d["type"] = get("transaction type", "transfer type", "jenis transaksi", "jenis transfer")
    d["when"] = get("transaction date", "tanggal transaksi")
    src = get("source of fund", "sumber dana", "rekening sumber")
    product = src.split(" - ")[0].strip() if " - " in src else ""
    d["from"] = {"bank": "BCA", "account": masked(src), "product": product.title() if product else ""}
    to: dict = {}
    if get("payment to", "merchant name", "nama merchant"):
        to["name"] = get("payment to", "merchant name", "nama merchant")
        to["location"] = re.sub(r"\s*,\s*", ", ", get("merchant location", "lokasi merchant")).strip(", ")
        to["via"] = get("acquirer")
        to["terminal"] = get("terminal id")
    if get("company/product name"):
        to["name"] = get("company/product name")
        to["holder"] = get("name", "nama")
        to["account"] = masked(get("bca virtual account no.", "virtual account no.", "no. virtual account"))
        to["kind"] = "Virtual account"
    if get("beneficiary name", "nama penerima", "receiver name"):
        to["name"] = get("beneficiary name", "nama penerima", "receiver name")
        acc = get("beneficiary account", "to account", "rekening tujuan", "no. rekening tujuan", "account number")
        to["account"] = masked(acc)
        to["bank"] = short_bank(get("beneficiary bank", "bank tujuan", "bank penerima")) or get("beneficiary bank", "bank tujuan")
    d["to"] = {k: v for k, v in to.items() if v}
    d["amount"] = money(get("pay amount", "transfer amount", "amount", "jumlah transfer", "nominal"))
    d["fee"] = money(get("admin fee", "fee", "biaya admin", "biaya"))
    d["total"] = money(get("total payment", "total pembayaran", "total transaksi", "total amount", "total"))
    d["refs"] = {k: v for k, v in {"RRN": get("rrn"), "Reference": get("reference no.", "no. referensi", "reference number")}.items() if v}
    note = get("remarks", "description", "berita", "keterangan", "news")
    d["note"] = "" if note in ("-", "") else note
    d["all"] = [[k.title() if k.islower() else k, v] for k, v in kv.items() if v and not any(n in k for n in NOISE)]
    return d


def mandiri_details(subject: str, body: str) -> dict:
    lines = lines_of(body)
    low = [ln.lower() for ln in lines]

    def after(label: str, n: int = 2) -> list[str]:
        for i, ln in enumerate(low):
            if ln == label:
                return [x for x in lines[i + 1:i + 1 + n]]
        return []

    def labelled(prefix: str) -> str:
        for ln in lines:
            if ln.lower().startswith(prefix):
                return ln[len(prefix):].strip()
        return ""

    d: dict = {"bank": "Mandiri", "channel": "Livin' by Mandiri"}
    s = subject.lower()
    d["status"] = "Gagal" if ("gagal" in s or "tidak berhasil" in s) else "Berhasil" if "berhasil" in s else ""
    d["type"] = re.sub(r"\s*(berhasil|gagal|tidak berhasil)\s*$", "", subject.split(":")[-1].strip(), flags=re.I)
    d["when"] = " ".join(x for x in (labelled("tanggal"), labelled("jam")) if x)
    src = after("rekening sumber")
    d["from"] = {"bank": "Mandiri", "account": masked(src[-1] if src else ""), "holder": src[0] if src else ""}
    to: dict = {}
    for label in ("penerima", "penyedia jasa", "merchant", "nama merchant", "tujuan", "pembayaran ke", "tagihan"):
        got = after(label)
        if got:
            to["name"] = got[0]
            extra = got[1] if len(got) > 1 else ""
            if " - " in extra:
                bank_part, acc = extra.rsplit(" - ", 1)
                to["bank"] = short_bank(bank_part) or bank_part
                to["account"] = masked(acc)
            elif extra:
                to["account"] = masked(extra)
            break
    d["to"] = to
    d["amount"] = money(labelled("nominal transfer") or labelled("nominal top-up") or labelled("nominal pembayaran") or labelled("nominal"))
    d["fee"] = money(labelled("biaya transfer") or labelled("biaya transaksi") or labelled("biaya admin") or labelled("biaya"))
    d["total"] = money(labelled("total transaksi") or labelled("total"))
    refs = {}
    for ln in lines:
        m = re.match(r"(no\.? referensi[^\d*]*)\s+(.+)$", ln, re.I)
        if m:
            refs[m.group(1).strip().title()] = m.group(2).strip()
    d["refs"] = refs
    purpose = labelled("tujuan transaksi")
    note = labelled("keterangan") or labelled("catatan") or labelled("berita")
    d["purpose"] = purpose
    d["note"] = "" if note in ("-", "") else note
    d["all"] = [[ln, ""] for ln in lines if not any(n in ln.lower() for n in NOISE) and not ln.startswith("<") and len(ln) < 80][:40]
    return d


def unwrap(sender: str, subject: str, body: str) -> tuple[str, str, str]:
    """Forwarded emails: the original From/Subject and the text after the forwarded header (any line endings)."""
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    marker = "---------- Forwarded message ---------"
    if marker not in body:
        return sender, subject, body
    rest = body.split(marker, 1)[1].lstrip("\n")
    lines = rest.split("\n")
    head_end = 0
    for i, ln in enumerate(lines[:12]):
        if re.match(r"^(From|Date|Subject|To|Cc):", ln.strip()):
            head_end = i + 1
    head = "\n".join(lines[:head_end])
    orig_from = re.search(r"^From:\s*(.+)$", head, re.M)
    orig_subj = re.search(r"^Subject:\s*(.+)$", head, re.M)
    return (orig_from.group(1).strip() if orig_from else sender,
            orig_subj.group(1).strip() if orig_subj else re.sub(r"^(Fwd?|FW):\s*", "", subject, flags=re.I),
            "\n".join(lines[head_end:]))


def email_details(sender: str, subject: str, body: str, parsed: dict | None = None) -> dict:
    sender, subject, body = unwrap(sender or "", subject or "", body or "")
    s = (sender + " " + subject).lower()
    try:
        if "bankmandiri" in s or "livin" in s:
            d = mandiri_details(subject, body)
        elif "bca" in s or "transaction journal" in s:
            d = bca_details(body)
        else:
            d = {"bank": (parsed or {}).get("bank", ""), "all": [[k, v] for k, v in kv_lines(body).items() if v][:30]}
    except Exception:  # noqa: BLE001 — details are a nice-to-have; never break the screen
        d = {}
    p = parsed or {}
    d.setdefault("from", {})
    if not d["from"].get("account") and p.get("account"):
        d["from"]["account"] = p["account"].split(" ", 1)[-1]
    d["from"]["label"] = " ".join(x for x in (d.get("bank") or p.get("bank", ""), d["from"].get("account", "")) if x)
    if p.get("kind") == "transfer":
        d.setdefault("to", {})["own"] = True
    if d.get("total") is None:
        d["total"] = p.get("amount") or None
    if d.get("fee") is None:
        d["fee"] = p.get("fee") or None
    if d.get("amount") is None and d.get("total"):
        d["amount"] = d["total"] - (d.get("fee") or 0)
    return d


def account_key(text: str) -> str:
    """'BCA …73' / 'BCA ••73' / 'Mandiri …8139' → 'BCA:73' (who owns which account is remembered by this key)."""
    m = re.match(r"\s*([A-Za-z' ]+?)\s*[.…•*x]*\s*(\d{2,4})\s*$", text or "")
    return f"{m.group(1).strip()}:{m.group(2)}" if m else ""
