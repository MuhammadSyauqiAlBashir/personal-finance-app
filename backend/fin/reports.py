"""Report data: daily, monthly, trends and forecast. AI notes are cached in fin_reports."""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from . import advisor, ai, budget, config
from .pb import PBError, pb, q

log = logging.getLogger("fin.reports")

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def local_day(occurred_at: str) -> date:
    return datetime.fromisoformat(occurred_at.replace(" ", "T").replace("Z", "+00:00")).astimezone(config.TZ).date()


def utc_bounds(start: date, end: date) -> tuple[str, str]:
    lo = datetime(start.year, start.month, start.day, tzinfo=config.TZ).astimezone(timezone.utc)
    hi = datetime(end.year, end.month, end.day, tzinfo=config.TZ) + timedelta(days=1)
    return lo.strftime("%Y-%m-%d %H:%M:%S"), hi.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def expense_lines(start: date, end: date) -> list[dict]:
    """Confirmed expense splits between two local dates, one row per split."""
    lo, hi = utc_bounds(start, end)
    txs = await pb.all("fin_transactions", filter=f"status = 'confirmed' && kind = 'expense' && "
                                                  f"occurred_at >= {q(lo)} && occurred_at < {q(hi)}")
    if not txs:
        return []
    by_id = {t["id"]: t for t in txs}
    rows = []
    # Fetch splits in chunks (filter length limits).
    ids = list(by_id)
    for i in range(0, len(ids), 40):
        chunk = ids[i:i + 40]
        for s in await pb.all("fin_splits", filter=" || ".join(f"transaction = {q(t)}" for t in chunk)):
            t = by_id[s["transaction"]]
            rows.append({"tx": t["id"], "day": local_day(t["occurred_at"]), "category": s["category"],
                         "amount": int(s["amount"]), "merchant": t.get("merchant") or "",
                         "receipt": t.get("receipt_state")})
    return rows


async def category_map() -> dict[str, dict]:
    return {c["id"]: c for c in await budget.categories(include_archived=True)}


def cat_public(c: dict | None) -> dict:
    c = c or {}
    return {k: c.get(k) for k in ("id", "name", "group", "icon", "color")}


# ---------------------------------------------------------------------------
# Daily
# ---------------------------------------------------------------------------

async def daily(d: date) -> dict:
    period = await budget.period_for(d)
    s = await budget.summary(period)
    rows = await expense_lines(d, d)
    cats = await category_map()
    by_cat: dict[str, int] = defaultdict(int)
    for r in rows:
        by_cat[r["category"]] += r["amount"]
    total = sum(by_cat.values())
    flexible_budget = sum(w["budget"] for w in s["wallets"] if w["category"]["group"] in ("needs", "wants"))
    daily_pace = flexible_budget // max(1, s["days_total"])
    flexible_today = sum(v for k, v in by_cat.items() if cats.get(k, {}).get("group") in ("needs", "wants"))
    biggest = sorted(rows, key=lambda r: -r["amount"])[:3]
    return {
        "demo": s["demo"],
        "date": d.isoformat(), "period": s["period"], "total": total,
        "by_category": [{"category": cat_public(cats.get(k)), "amount": v}
                        for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1])],
        "daily_pace": daily_pace, "flexible_today": flexible_today,
        "vs_pace": round(flexible_today / daily_pace, 2) if daily_pace else None,
        "safe_tomorrow": s["safe_today"], "pending": s["pending"], "days_left": s["days_left"],
        "biggest": [{"merchant": b["merchant"], "amount": b["amount"],
                     "category": cat_public(cats.get(b["category"]))} for b in biggest],
    }


# ---------------------------------------------------------------------------
# Monthly
# ---------------------------------------------------------------------------

async def monthly(period: dict) -> dict:
    s = await budget.summary(period)
    start, end = budget.parse(period["start"]), budget.parse(period["end"])
    rows = await expense_lines(start, end)
    cats = await category_map()

    per_day: dict[str, int] = defaultdict(int)
    merchants: dict[str, int] = defaultdict(int)
    weekday: dict[int, list[int]] = defaultdict(list)
    tx_receipts: dict[str, str] = {}
    for r in rows:
        per_day[r["day"].isoformat()] += r["amount"]
        if r["merchant"]:
            merchants[r["merchant"]] += r["amount"]
        tx_receipts[r["tx"]] = r["receipt"]
    d = start
    days = []
    while d <= min(end, budget.today()):
        amt = per_day.get(d.isoformat(), 0)
        weekday[d.weekday()].append(amt)
        days.append({"date": d.isoformat(), "amount": amt})
        d += timedelta(days=1)

    income = s["income"] or 1
    must_needs = s["groups"]["must"]["spent"] + s["groups"]["needs"]["spent"]
    wants = s["groups"]["wants"]["spent"]
    savings = s["groups"]["savings"]["budget"]  # unassigned money is shown separately, not as savings
    prev = await pb.first("fin_periods", f"end < {q(period['start'])}", sort="-end")
    prev_spent = await budget.spent_by_category(prev["id"]) if prev else {}
    coverage = {"attached": 0, "waived": 0, "missing": 0}
    for state in tx_receipts.values():
        coverage[state if state in coverage else "missing"] += 1

    notes = []
    lo, hi = utc_bounds(start, end)
    for t in await pb.all("fin_transactions", filter=f"status = 'confirmed' && note != '' && "
                                                     f"occurred_at >= {q(lo)} && occurred_at < {q(hi)}",
                          sort="-occurred_at", fields="id,occurred_at,merchant,amount,note"):
        notes.append({"date": local_day(t["occurred_at"]).isoformat(), "merchant": t.get("merchant") or "",
                      "amount": int(t["amount"]), "note": t["note"]})
    return {
        "demo": s["demo"], "notes": notes[:50],
        "period": s["period"], "income": s["income"], "incomes": [
            {"source": i["source"], "amount": i["amount"], "date": i.get("date")} for i in s["incomes"]],
        "assigned": s["assigned"], "to_assign": s["to_assign"], "spent": s["spent"],
        "days_total": s["days_total"], "days_left": s["days_left"],
        "wallets": [{**w, "prev_spent": prev_spent.get(w["category"]["id"], 0)} for w in s["wallets"]],
        "groups": s["groups"],
        "rule_50_30_20": {
            "needs": {"actual": round(must_needs / income * 100, 1), "target": 50},
            "wants": {"actual": round(wants / income * 100, 1), "target": 30},
            "savings": {"actual": round(savings / income * 100, 1), "target": 20},
        },
        "top_merchants": [{"merchant": m, "amount": a} for m, a in sorted(merchants.items(), key=lambda kv: -kv[1])[:8]],
        "days": days,
        "weekday_avg": [{"day": WEEKDAYS[i], "amount": (sum(weekday[i]) // len(weekday[i])) if weekday[i] else 0}
                        for i in range(7)],
        "receipts": coverage,
        "closing": period.get("closing"),
    }


async def cached_text(kind: str, key: str, make) -> str:
    rec = await pb.first("fin_reports", f"kind = {q(kind)} && key = {q(key)}")
    if rec and rec.get("ai_text"):
        return rec["ai_text"]
    text = await make()
    try:
        if rec:
            await pb.update("fin_reports", rec["id"], {"ai_text": text})
        else:
            await pb.create("fin_reports", {"kind": kind, "key": key, "ai_text": text, "data": {}})
    except PBError as e:
        log.warning("cache report text failed: %s", e)
    return text


async def monthly_review(period: dict, refresh: bool = False) -> str:
    data = await monthly(period)
    cats = await category_map()
    compact = {
        "period": data["period"], "income": data["income"], "spent": data["spent"],
        "wallets": [{"name": w["category"]["name"], "group": w["category"]["group"], "budget": w["budget"],
                     "spent": w["spent"], "prev_spent": w["prev_spent"]} for w in data["wallets"]],
        "rule_50_30_20": data["rule_50_30_20"], "top_merchants": data["top_merchants"],
        "weekday_avg": data["weekday_avg"], "receipts": data["receipts"], "closing": data["closing"],
        "goals": [{"name": g["name"], "saved": g.get("saved"), "target": g.get("target")}
                  for g in await pb.all("fin_goals", filter="archived = false")],
    }
    del cats
    if refresh:
        rec = await pb.first("fin_reports", f"kind = 'monthly' && key = {q(period['start'])}")
        if rec:
            await pb.update("fin_reports", rec["id"], {"ai_text": ""})
    return await cached_text("monthly", period["start"], lambda: advisor.monthly_review(compact))


# ---------------------------------------------------------------------------
# Trends and forecast
# ---------------------------------------------------------------------------

async def trends(n: int = 6) -> dict:
    periods = (await pb.all("fin_periods", sort="-start"))[:n]
    periods.reverse()
    demo = await budget.demo_period_ids()
    cats = await category_map()
    out = []
    for p in periods:
        spent = await budget.spent_by_category(p["id"])
        income = sum(int(i["amount"]) for i in await pb.all("fin_incomes", filter=f"period = {q(p['id'])}"))
        groups: dict[str, int] = defaultdict(int)
        for cid, v in spent.items():
            groups[cats.get(cid, {}).get("group", "needs")] += v
        out.append({"period": {"id": p["id"], "start": p["start"], "end": p["end"]}, "income": income,
                    "demo": p["id"] in demo,
                    "spent": sum(spent.values()), "groups": groups,
                    "by_category": {cid: v for cid, v in spent.items()}})
    return {"periods": out, "categories": {cid: cat_public(c) for cid, c in cats.items()}}


async def forecast() -> dict:
    period = await budget.period_for()
    s = await budget.summary(period)
    start = budget.parse(period["start"])
    t = budget.today()
    elapsed = max(1, (t - start).days + 1)
    rows = await expense_lines(start, t)
    cats = await category_map()
    daily_totals = defaultdict(int)
    for r in rows:
        if cats.get(r["category"], {}).get("group") in ("needs", "wants"):
            daily_totals[r["day"]] += r["amount"]
    series = [daily_totals.get(start + timedelta(days=i), 0) for i in range(elapsed)]
    mean = sum(series) / elapsed
    var = sum((x - mean) ** 2 for x in series) / elapsed
    sd = math.sqrt(var)
    days_left = s["days_left"]

    bills = await pb.all("fin_bills", filter="active = true")
    paid = {b["bill"] for b in await pb.all("fin_bill_payments", filter=f"period = {q(period['id'])}")}
    unpaid = [b for b in bills if b["id"] not in paid]
    unpaid_total = sum(int(b.get("amount") or 0) for b in unpaid)

    flexible_spent = sum(series)
    projected_flexible = flexible_spent + mean * days_left
    spread = 1.28 * sd * math.sqrt(days_left)  # ~80% range
    projected_total = s["spent"] + mean * days_left + unpaid_total

    wallets = []
    for w in s["wallets"]:
        g = w["category"]["group"]
        if g not in ("needs", "wants") or not w["budget"]:
            continue
        rate = w["spent"] / elapsed
        projected = w["spent"] + rate * days_left
        runs_out = None
        if rate > 0 and w["left"] > 0:
            days_until = w["left"] / rate
            if days_until < days_left:
                runs_out = (t + timedelta(days=int(days_until))).isoformat()
        elif w["left"] <= 0:
            runs_out = t.isoformat()
        wallets.append({"category": w["category"], "budget": w["budget"], "spent": w["spent"],
                        "projected": int(projected), "over_by": max(0, int(projected - w["budget"])),
                        "runs_out": runs_out})

    goals = []
    moves = await pb.all("fin_goal_moves", filter="amount > 0")
    by_goal_period: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for m in moves:
        by_goal_period[m["goal"]][m.get("period") or "none"] += int(m["amount"])
    savings_alloc = sum(w["budget"] for w in s["wallets"] if w["category"]["group"] == "savings")
    for g in await pb.all("fin_goals", filter="archived = false"):
        history = by_goal_period.get(g["id"], {})
        monthly_rate = (sum(history.values()) / max(1, len(history))) if history else 0
        if not monthly_rate and g["kind"] == "emergency":
            monthly_rate = savings_alloc  # before any history: assume this month's savings plan
        remaining = max(0, int(g.get("target") or 0) - int(g.get("saved") or 0))
        months = math.ceil(remaining / monthly_rate) if monthly_rate and remaining else (0 if not remaining else None)
        goals.append({"id": g["id"], "name": g["name"], "kind": g["kind"], "saved": g.get("saved") or 0,
                      "target": g.get("target") or 0, "monthly_rate": int(monthly_rate), "months_to_go": months,
                      "target_date": g.get("target_date") or ""})
    return {
        "demo": s["demo"],
        "period": s["period"], "days_left": days_left, "elapsed": elapsed,
        "daily_average": int(mean), "income": s["income"], "spent": s["spent"],
        "projected_total": int(projected_total),
        "projected_range": [int(max(s["spent"], projected_total - spread)), int(projected_total + spread)],
        "projected_flexible": int(projected_flexible), "unpaid_bills": [
            {"name": b["name"], "amount": b.get("amount"), "due_day": b.get("due_day")} for b in unpaid],
        "wallets": sorted(wallets, key=lambda w: (w["runs_out"] is None, w["runs_out"] or "")),
        "goals": goals,
        "enough_data": elapsed >= 5 and len(rows) >= 5,
    }


async def ai_note(kind: str, key: str, data: dict) -> str:
    try:
        return await cached_text("note", f"{kind}:{key}", lambda: advisor.commentary(kind, data))
    except ai.AIUnavailable:
        return ""
