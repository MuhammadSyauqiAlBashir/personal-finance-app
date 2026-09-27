"""Mask account/card/reference numbers in bank email text.

Runs before anything is stored or sent to Gemini. Digit runs of 10 or more
(account numbers, card numbers, references; spaces or dashes allowed inside)
keep only their last 4 digits. Amounts are left alone: bank emails write them
with separators (1.250.000,00), and 10+ digit amounts would be over Rp1 billion.
"""

import re

_LONG_NUMBER = re.compile(r"(?<![\d.,])(\d(?:[ -]?\d){9,})(?![\d])")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def _mask(m: re.Match) -> str:
    digits = re.sub(r"\D", "", m.group(1))
    return "*" * (len(digits) - 4) + digits[-4:]


def redact(text: str, names: list[str] | None = None) -> str:
    text = _LONG_NUMBER.sub(_mask, text or "")
    text = _EMAIL.sub(lambda m: m.group(0) if m.group(0).lower().endswith(
        ("bca.co.id", "klikbca.com", "bankmandiri.co.id")) else "[email]", text)
    for name in names or []:
        name = name.strip()
        if len(name) >= 3:
            text = re.sub(re.escape(name), "[owner]", text, flags=re.I)
    return text
