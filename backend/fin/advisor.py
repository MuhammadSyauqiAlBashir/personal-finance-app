"""AI advice: starter categories, wallet amounts, monthly review, chat."""

from __future__ import annotations

import json
import logging

from . import ai, budget
from .categorize import profile_context
from .pb import pb, q

log = logging.getLogger("fin.advisor")

ADVISOR_SYSTEM = """You are a careful, practical personal finance advisor for an Indonesian household
(amounts in rupiah). You follow envelope/zero-based budgeting: every rupiah of income is assigned to a
wallet. Priorities, in order: must-spend obligations; an emergency fund (target 3-6 months of must +
needs spending, 6 for single income or dependants); avoiding consumer debt; then goals and lifestyle.
Common Indonesian guidance: housing <= 30% of income, installments/debt <= 30%, save >= 10-20%;
consider zakat/infaq, BPJS, family support, Lebaran/THR season and school fees when relevant.
Be specific with numbers, kind, and brief. Respect the family's stated values and priorities.
Never give instructions to buy specific financial products; general guidance only."""


def rp(n: int) -> str:
    return "Rp" + f"{int(n):,}".replace(",", ".")


STARTER_SCHEMA = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "group": {"type": "string", "enum": ["must", "needs", "wants", "savings"]},
                    "icon": {"type": "string", "description": "one emoji"},
                    "hints": {"type": "string", "description": "what belongs here, short"},
                },
                "required": ["name", "group", "icon", "hints"],
                "propertyOrdering": ["name", "group", "icon", "hints"],
            },
        },
        "note": {"type": "string"},
    },
    "required": ["categories", "note"],
    "propertyOrdering": ["categories", "note"],
}


async def starter_categories() -> dict:
    ctx = await profile_context()
    prompt = ("Propose a starting category list (12-20 wallets) for this household's envelope budget. "
              "Include 'Bank & admin fees' (needs) and an 'E-wallet purchases' category is NOT needed "
              "(e-wallet purchases are categorised individually). Use clear English names.\n\n"
              f"Family profile:\n{ctx or '(not filled in yet: assume a young Indonesian couple in a city)'}")
    return await ai.generate([prompt], system=ADVISOR_SYSTEM, schema=STARTER_SCHEMA, smart=True, temperature=0.4)


ALLOC_SCHEMA = {
    "type": "object",
    "properties": {
        "allocations": {
            "type": "array",
            "items": {"type": "object", "properties": {
                "category_id": {"type": "string"}, "why": {"type": "string"},
                "amount": {**ai.MONEY, "description": "whole rupiah digits only, e.g. 1500000"}},
                "required": ["category_id", "why", "amount"], "propertyOrdering": ["category_id", "why", "amount"]},
        },
        "summary": {"type": "string", "description": "3-5 short sentences explaining the plan"},
    },
    "required": ["allocations", "summary"],
    "propertyOrdering": ["allocations", "summary"],
}


async def history_lines(months: int = 3) -> str:
    demo = await budget.demo_period_ids()
    periods = [p for p in await pb.all("fin_periods", filter="status = 'closed'", sort="-start") if p["id"] not in demo]
    cats = {c["id"]: c["name"] for c in await budget.categories(include_archived=True)}
    lines = []
    for p in periods[:months]:
        spent = await budget.spent_by_category(p["id"])
        income = sum(int(i["amount"]) for i in await pb.all("fin_incomes", filter=f"period = {q(p['id'])}"))
        top = ", ".join(f"{cats.get(k, '?')} {rp(v)}" for k, v in sorted(spent.items(), key=lambda kv: -kv[1]))
        lines.append(f"{p['start']}..{p['end']}: income {rp(income)}; spent {top or 'nothing recorded'}")
    return "\n".join(lines)


async def suggest_allocations(period: dict) -> dict:
    s = await budget.summary(period)
    cats = await budget.categories()
    bills = await pb.all("fin_bills", filter="active = true")
    goals = await pb.all("fin_goals", filter="archived = false")
    cat_lines = "\n".join(f"- id={c['id']} | {c['name']} | group={c['group']}"
                          + (f" | usual {rp(c['default_amount'])}" if c.get("default_amount") else "") for c in cats)
    bill_lines = "\n".join(f"- {b['name']}: {rp(b['amount'])} (due day {b.get('due_day') or '?'}, "
                           f"category id={b['category']})" for b in bills) or "(none)"
    goal_lines = "\n".join(f"- {g['name']} ({g['kind']}): saved {rp(g.get('saved') or 0)} of "
                           f"{rp(g.get('target') or 0)}" + (f", by {g['target_date']}" if g.get("target_date") else "")
                           for g in goals) or "(none)"
    prompt = (f"Plan wallet amounts for the budget month {period['start']} to {period['end']}.\n"
              f"Income to assign: {rp(s['income'])}. The allocations must add up to exactly this.\n\n"
              f"Categories:\n{cat_lines}\n\nMust-spend bills:\n{bill_lines}\n\nGoals:\n{goal_lines}\n\n"
              f"Recent months:\n{await history_lines() or '(no history yet)'}\n\n"
              f"Family profile:\n{await profile_context() or '(none)'}\n\n"
              "Cover every bill in its category first. Savings-group categories fund goals. "
              "Round amounts to Rp10.000 (small categories Rp5.000).")
    out = await ai.generate([prompt], system=ADVISOR_SYSTEM, schema=ALLOC_SCHEMA, smart=True)
    ids = {c["id"] for c in cats}
    for a in out.get("allocations", []):
        a["amount"] = ai.money(a.get("amount"))
    allocs = [a for a in out.get("allocations", []) if a.get("category_id") in ids]
    # Make it add up exactly: put rounding differences into the largest savings wallet (or the largest wallet).
    diff = s["income"] - sum(int(a["amount"]) for a in allocs)
    if allocs and diff:
        group = {c["id"]: c["group"] for c in cats}
        target = max((a for a in allocs if group[a["category_id"]] == "savings"), default=None,
                     key=lambda a: a["amount"]) or max(allocs, key=lambda a: a["amount"])
        target["amount"] = max(0, int(target["amount"]) + diff)
    return {"allocations": allocs, "summary": out.get("summary", "")}


REVIEW_SYSTEM = ADVISOR_SYSTEM + """
Write a monthly review in this structure, using short markdown sections:
## Summary (2-3 sentences)
## What went well
## Watch out
## Next month (concrete wallet changes with amounts)"""


async def monthly_review(data: dict) -> str:
    prompt = (f"Family profile:\n{await profile_context() or '(none)'}\n\n"
              f"Month data (JSON):\n{json.dumps(data, ensure_ascii=False)[:30000]}")
    return await ai.generate([prompt], system=REVIEW_SYSTEM, smart=True, temperature=0.4)


async def commentary(kind: str, data: dict) -> str:
    """Short AI note for a report card (2-4 sentences)."""
    prompt = (f"Write a 2-4 sentence note for the household's {kind} report. Point out the most important "
              f"thing and one concrete action. Data:\n{json.dumps(data, ensure_ascii=False)[:15000]}\n\n"
              f"Family profile:\n{await profile_context() or '(none)'}")
    return await ai.generate([prompt], system=ADVISOR_SYSTEM, smart=False, temperature=0.4)


async def chat_context() -> str:
    period = await budget.real_period()  # demo months are never advice context
    s = await budget.summary(period)
    wallets = "\n".join(f"- {w['category']['name']} ({w['category']['group']}): budget {rp(w['budget'])}, "
                        f"spent {rp(w['spent'])}, left {rp(w['left'])}" for w in s["wallets"])
    goals = "\n".join(f"- {g['name']}: {rp(g.get('saved') or 0)} / {rp(g.get('target') or 0)}"
                      for g in await pb.all("fin_goals", filter="archived = false")) or "(none)"
    starts_in = (budget.parse(period["start"]) - budget.today()).days
    timing = (f"starts in {starts_in} day{'s' if starts_in != 1 else ''}; real tracking begins then" if starts_in > 0
              else f"{s['days_left']} days left including today")
    return (f"Today is {budget.today():%A %d %B %Y}. Budget month {period['start']}..{period['end']} ({timing}).\n"
            f"Income {rp(s['income'])}, assigned {rp(s['assigned'])}, spent {rp(s['spent'])}, "
            f"safe to spend today {rp(s['safe_today'])}, pending confirmations {s['pending']}.\n"
            f"Wallets:\n{wallets}\nGoals:\n{goals}\nRecent months:\n{await history_lines(6) or '(none)'}\n"
            f"Family profile:\n{await profile_context() or '(none)'}")


async def chat(history: list[dict], message: str) -> str:
    context = await chat_context()
    contents = [{"role": "user" if h["role"] == "user" else "model", "parts": [{"text": h["content"]}]}
                for h in history[-20:]]
    return await ai.generate([f"Current finances:\n{context}\n\nQuestion: {message}"],
                             system=ADVISOR_SYSTEM, smart=True, temperature=0.5, history=contents)
